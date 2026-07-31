import { Client } from 'pg'
import type { Duplex } from 'node:stream'

import { DatabaseConnectionError } from '../connections/connector-error.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type {
  DatabaseColumn,
  DatabaseGateway,
  DatabaseTable,
  RowPage,
} from './database-explorer.js'

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export class PostgresDatabaseGateway implements DatabaseGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listSchemas(connection: ResolvedConnection): Promise<string[]> {
    const result = await this.query(
      connection,
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         AND schema_name NOT LIKE 'pg_toast%'
       ORDER BY schema_name`,
    )
    return result.rows.map((row) => String(row.schema_name))
  }

  async listTables(connection: ResolvedConnection, schema: string): Promise<DatabaseTable[]> {
    const result = await this.query(
      connection,
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    )
    return result.rows.map((row) => ({
      schema: String(row.table_schema),
      name: String(row.table_name),
      type: row.table_type === 'VIEW' ? 'view' : 'table',
    }))
  }

  async describeTable(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<DatabaseColumn[]> {
    const result = await this.query(
      connection,
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
              ) AS primary_key
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table],
    )
    return result.rows.map(mapColumn)
  }

  async readRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; offset: number },
  ): Promise<RowPage> {
    const result = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)} LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    )
    return {
      columns: result.fields?.map((field) => field.name) ?? Object.keys(result.rows[0] ?? {}),
      rows: result.rows,
      nextOffset: result.rows.length === page.limit ? page.offset + result.rows.length : null,
    }
  }

  private async query(connection: ResolvedConnection, sql: string, values?: unknown[]) {
    let client: PostgresClientLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      return await client.query(sql, values)
    } catch {
      throw new DatabaseConnectionError()
    } finally {
      try {
        await client?.end()
      } catch {
        // Cleanup errors must not replace the query result or its safe error.
      }
      socket?.destroy()
    }
  }
}

function mapColumn(row: Record<string, unknown>): DatabaseColumn {
  return {
    name: String(row.column_name),
    dataType: String(row.data_type),
    nullable: row.is_nullable === 'YES',
    primaryKey: row.primary_key === true,
    ...(row.column_default == null ? {} : { defaultValue: String(row.column_default) }),
  }
}
