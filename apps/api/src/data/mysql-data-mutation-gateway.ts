import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import {
  mysqlClientOptions,
  type MysqlClientOptions,
} from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  DataMutationError,
  type DataMutationGateway,
  type DataMutationRequest,
  type DataMutationResult,
} from './data-mutation-service.js'
import { buildMysqlMutation, expandMutationOperations } from './mutation-sql.js'
import type { DatabaseValueType } from './tagged-value.js'
import type { MutationTable, MutationUniqueKey } from './row-write-policy.js'

interface MysqlMutationConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  end(): Promise<void>
}

type MysqlMutationConnectionFactory = (
  options: MysqlClientOptions,
) => Promise<MysqlMutationConnection>

export class MysqlDataMutationGateway implements DataMutationGateway {
  constructor(
    private readonly createConnection: MysqlMutationConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlMutationConnection,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async describeTable(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<MutationTable> {
    return this.withConnection(connection, async (client) => {
      const [rawColumns] = await client.query(
        `SELECT column_name, data_type, column_type, is_nullable, extra
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [schema, table],
      )
      const [rawKeys] = await client.query(
        `SELECT index_name AS key_name, non_unique, column_name,
                seq_in_index AS sequence
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND non_unique = 0
         ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
        [schema, table],
      )
      const columns = asRows(rawColumns)
      return {
        schema,
        name: table,
        columns: columns.map((row) => ({
          name: String(row.column_name),
          valueType: mysqlValueType(String(row.data_type), String(row.column_type)),
          nullable: row.is_nullable === 'YES',
          generated: /(?:auto_increment|generated)/i.test(String(row.extra ?? '')),
        })),
        uniqueKeys: mapMysqlKeys(asRows(rawKeys)),
      }
    })
  }

  async executeTransaction(
    connection: ResolvedConnection,
    request: DataMutationRequest & { metadata: MutationTable },
  ): Promise<DataMutationResult> {
    return this.withConnection(connection, async (client) => {
      await client.beginTransaction()
      try {
        const operations = expandMutationOperations(request.operations)
        const items = []
        let affectedRows = 0
        for (const [index, operation] of operations.entries()) {
          const built = buildMysqlMutation(request.schema, request.table, operation)
          const [rawResult] = await client.query(built.sql, built.values)
          const result = asResultHeader(rawResult)
          if (operation.kind !== 'insert' && result.affectedRows !== 1) {
            throw new DataMutationError('ROW_CONFLICT', index)
          }
          items.push({
            index,
            affectedRows: result.affectedRows,
            ...(operation.kind === 'insert' && result.insertId !== 0
              ? { insertId: String(result.insertId) }
              : {}),
          })
          affectedRows += result.affectedRows
        }
        await client.commit()
        return { affectedRows, items }
      } catch (error) {
        try {
          await client.rollback()
        } catch {
          // The original mutation error remains authoritative if rollback also fails.
        }
        throw error instanceof DataMutationError
          ? error
          : new DataMutationError('MUTATION_FAILED')
      }
    })
  }

  private async withConnection<T>(
    connection: ResolvedConnection,
    operation: (client: MysqlMutationConnection) => Promise<T>,
  ): Promise<T> {
    let client: MysqlMutationConnection | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
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

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new DataMutationError('MUTATION_FAILED')
  return value as Array<Record<string, unknown>>
}

function asResultHeader(value: unknown): { affectedRows: number; insertId: number | string } {
  if (!value || typeof value !== 'object') throw new DataMutationError('MUTATION_FAILED')
  const header = value as { affectedRows?: unknown; insertId?: unknown }
  if (typeof header.affectedRows !== 'number') throw new DataMutationError('MUTATION_FAILED')
  return {
    affectedRows: header.affectedRows,
    insertId: typeof header.insertId === 'number' || typeof header.insertId === 'string'
      ? header.insertId
      : 0,
  }
}

function mysqlValueType(dataType: string, columnType: string): DatabaseValueType | 'unsupported' {
  if (dataType === 'bigint') return 'bigint'
  if (dataType === 'decimal' || dataType === 'numeric') return 'decimal'
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'float', 'double'].includes(dataType)) {
    return 'number'
  }
  if (dataType === 'bit' && columnType === 'bit(1)') return 'boolean'
  if (dataType === 'date') return 'date'
  if (dataType === 'time') return 'time'
  if (dataType === 'datetime' || dataType === 'timestamp') return 'datetime'
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(dataType)) return 'binary'
  if (dataType === 'json') return 'json'
  if (dataType === 'enum') return 'enum'
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext'].includes(dataType)) return 'string'
  return 'unsupported'
}

function mapMysqlKeys(rows: Array<Record<string, unknown>>): MutationUniqueKey[] {
  const keys = new Map<string, { kind: 'primary' | 'unique'; columns: Array<{ name: string; sequence: number }> }>()
  for (const row of rows) {
    const name = String(row.key_name)
    const current = keys.get(name) ?? {
      kind: name === 'PRIMARY' ? 'primary' as const : 'unique' as const,
      columns: [],
    }
    current.columns.push({ name: String(row.column_name), sequence: Number(row.sequence) })
    keys.set(name, current)
  }
  return [...keys].map(([name, key]) => ({
    name,
    kind: key.kind,
    columns: key.columns.sort((left, right) => left.sequence - right.sequence).map((column) => column.name),
  }))
}
