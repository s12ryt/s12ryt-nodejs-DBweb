import mysql, { type ConnectionOptions } from 'mysql2/promise'
import type { Duplex } from 'node:stream'

import { DatabaseConnectionError } from '../connections/connector-error.js'
import {
  mysqlClientOptions,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type {
  DatabaseColumn,
  DatabaseGateway,
  DatabaseTable,
  RowPage,
} from './database-explorer.js'

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}

export class MysqlDatabaseGateway implements DatabaseGateway {
  constructor(
    private readonly createConnection: MysqlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlConnectionLike,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listSchemas(connection: ResolvedConnection): Promise<string[]> {
    const [rows] = await this.query(
      connection,
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
       ORDER BY schema_name`,
    )
    return rows.map((row) => String(row.schema_name))
  }

  async listTables(connection: ResolvedConnection, schema: string): Promise<DatabaseTable[]> {
    const [rows] = await this.query(
      connection,
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema = ? ORDER BY table_name`,
      [schema],
    )
    return rows.map((row) => ({
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
    const [rows] = await this.query(
      connection,
      `SELECT column_name, column_type AS data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [schema, table],
    )
    return rows.map((row) => ({
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: row.is_nullable === 'YES',
      primaryKey: row.column_key === 'PRI',
      ...(row.column_default == null ? {} : { defaultValue: String(row.column_default) }),
    }))
  }

  async readRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; offset: number },
  ): Promise<RowPage> {
    const [rows, fields] = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)} LIMIT ? OFFSET ?`,
      [page.limit, page.offset],
    )
    const fieldList = Array.isArray(fields) ? (fields as Array<{ name?: unknown }>) : []
    return {
      columns:
        fieldList.length > 0
          ? fieldList.map((field) => String(field.name))
          : Object.keys(rows[0] ?? {}),
      rows,
      nextOffset: rows.length === page.limit ? page.offset + rows.length : null,
    }
  }

  private async query(connection: ResolvedConnection, sql: string, values?: unknown[]) {
    let client: MysqlConnectionLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
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
