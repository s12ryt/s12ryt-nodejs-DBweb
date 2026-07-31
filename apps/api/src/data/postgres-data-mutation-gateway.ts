import type { Duplex } from 'node:stream'

import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  DataMutationError,
  type DataMutationGateway,
  type DataMutationRequest,
  type DataMutationResult,
} from './data-mutation-service.js'
import {
  buildPostgresMutation,
  expandMutationOperations,
} from './mutation-sql.js'
import type { DatabaseValueType } from './tagged-value.js'
import type { MutationTable, MutationUniqueKey } from './row-write-policy.js'

export class PostgresDataMutationGateway implements DataMutationGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async describeTable(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<MutationTable> {
    return this.withClient(connection, async (client) => {
      const columnResult = await client.query(
        `SELECT a.attname AS column_name, t.typname AS type_name,
                t.typcategory AS type_category, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_expression
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_attrdef d
           ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname = $1 AND c.relname = $2
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table],
      )
      const keyResult = await client.query(
        `SELECT i.relname AS key_name, x.indisprimary AS primary_key,
                array_agg(a.attname ORDER BY k.ordinality) AS columns
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class c ON c.oid = x.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
         JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE n.nspname = $1 AND c.relname = $2 AND x.indisunique
           AND x.indpred IS NULL AND x.indexprs IS NULL
         GROUP BY i.relname, x.indisprimary
         ORDER BY x.indisprimary DESC, i.relname`,
        [schema, table],
      )
      return {
        schema,
        name: table,
        columns: columnResult.rows.map((row) => ({
          name: String(row.column_name),
          valueType: postgresValueType(String(row.type_name), String(row.type_category)),
          nullable: row.nullable === true,
          generated: /^nextval\(/i.test(String(row.default_expression ?? '')),
        })),
        uniqueKeys: keyResult.rows.map(mapPostgresKey),
      }
    })
  }

  async executeTransaction(
    connection: ResolvedConnection,
    request: DataMutationRequest & { metadata: MutationTable },
  ): Promise<DataMutationResult> {
    return this.withClient(connection, async (client) => {
      await client.query('BEGIN')
      try {
        const operations = expandMutationOperations(request.operations)
        const returningColumn = request.metadata.uniqueKeys.find((key) => key.kind === 'primary')?.columns[0]
        const items = []
        let affectedRows = 0
        for (const [index, operation] of operations.entries()) {
          const built = buildPostgresMutation(
            request.schema,
            request.table,
            operation,
            operation.kind === 'insert' ? returningColumn : undefined,
          )
          const result = await client.query(built.sql, built.values)
          const count = result.rowCount ?? 0
          if (operation.kind !== 'insert' && count !== 1) {
            throw new DataMutationError('ROW_CONFLICT', index)
          }
          const firstValue = operation.kind === 'insert' && result.rows[0]
            ? Object.values(result.rows[0])[0]
            : undefined
          items.push({
            index,
            affectedRows: count,
            ...(firstValue == null ? {} : { insertId: String(firstValue) }),
          })
          affectedRows += count
        }
        await client.query('COMMIT')
        return { affectedRows, items }
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The original mutation error remains authoritative if rollback also fails.
        }
        throw error instanceof DataMutationError
          ? error
          : new DataMutationError('MUTATION_FAILED')
      }
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    operation: (client: PostgresClientLike) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClientLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      return await operation(client)
    } catch (error) {
      throw error instanceof DataMutationError
        ? error
        : new DataMutationError('MUTATION_FAILED')
    } finally {
      try {
        await client?.end()
      } catch {
        // Cleanup errors must not replace the mutation result or its safe error.
      }
      socket?.destroy()
    }
  }
}

function postgresValueType(type: string, category: string): DatabaseValueType | 'unsupported' {
  if (category === 'A') return 'array'
  if (category === 'E') return 'enum'
  if (type === 'int8') return 'bigint'
  if (type === 'numeric' || type === 'decimal') return 'decimal'
  if (type === 'int2' || type === 'int4' || type === 'float4' || type === 'float8') return 'number'
  if (type === 'bool') return 'boolean'
  if (type === 'date') return 'date'
  if (type === 'time' || type === 'timetz') return 'time'
  if (type === 'timestamp') return 'datetime'
  if (type === 'timestamptz') return 'timestamptz'
  if (type === 'bytea') return 'binary'
  if (type === 'json' || type === 'jsonb') return 'json'
  if (type === 'uuid') return 'uuid'
  if (category === 'S' || type === 'varchar' || type === 'bpchar' || type === 'text') return 'string'
  return 'unsupported'
}

function mapPostgresKey(row: Record<string, unknown>): MutationUniqueKey {
  return {
    name: String(row.key_name),
    kind: row.primary_key === true ? 'primary' : 'unique',
    columns: Array.isArray(row.columns) ? row.columns.map(String) : [],
  }
}
