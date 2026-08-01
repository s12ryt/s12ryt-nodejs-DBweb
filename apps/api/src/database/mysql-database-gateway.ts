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
  RowPagination,
  RowPage,
} from './database-explorer.js'
import { buildKeysetPredicate, encodeKeysetCursor, type KeysetCursorValue } from './keyset-pagination.js'

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

  async findStableKey(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<string[] | undefined> {
    const [rows] = await this.query(
      connection,
      `SELECT statistics.index_name AS key_name,
              (statistics.index_name = 'PRIMARY') AS primary_key,
              statistics.column_name,
              statistics.seq_in_index AS ordinal_position,
              0 AS nullable_column
       FROM information_schema.statistics statistics
       WHERE statistics.table_schema = ? AND statistics.table_name = ?
         AND statistics.non_unique = 0
         AND NOT EXISTS (
           SELECT 1
           FROM information_schema.statistics nullable_statistics
           JOIN information_schema.columns nullable_column
             ON nullable_column.table_schema = nullable_statistics.table_schema
            AND nullable_column.table_name = nullable_statistics.table_name
            AND nullable_column.column_name = nullable_statistics.column_name
           WHERE nullable_statistics.table_schema = statistics.table_schema
             AND nullable_statistics.table_name = statistics.table_name
             AND nullable_statistics.index_name = statistics.index_name
             AND nullable_column.is_nullable = 'YES'
         )
       ORDER BY primary_key DESC, statistics.index_name, statistics.seq_in_index`,
      [schema, table],
    )
    return firstStableKey(rows)
  }

  async readRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; pagination: RowPagination },
  ): Promise<RowPage> {
    if (page.pagination.mode === 'keyset') {
      return this.readKeysetRows(connection, { ...page, pagination: page.pagination })
    }
    const [rows, fields] = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)} LIMIT ? OFFSET ?`,
      [page.limit + 1, page.pagination.offset],
    )
    const fieldList = Array.isArray(fields) ? (fields as Array<{ name?: unknown }>) : []
    const selectedRows = rows.slice(0, page.limit)
    return {
      columns:
        fieldList.length > 0
          ? fieldList.map((field) => String(field.name))
          : Object.keys(rows[0] ?? {}),
      rows: selectedRows,
      paginationMode: 'offset',
      nextOffset: rows.length > page.limit ? page.pagination.offset + selectedRows.length : null,
      warning: 'OFFSET_PAGINATION',
    }
  }

  private async readKeysetRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; pagination: Extract<RowPagination, { mode: 'keyset' }> },
  ): Promise<RowPage> {
    const predicate = page.pagination.values
      ? buildKeysetPredicate('mysql', page.pagination.key, page.pagination.values, page.pagination.direction)
      : {
          sql: '',
          values: [] as KeysetCursorValue[],
          orderBy: page.pagination.key.map((column) => `${quoteIdentifier(column)} ${page.pagination.direction === 'forward' ? 'ASC' : 'DESC'}`).join(', '),
          reverseResults: page.pagination.direction === 'backward',
        }
    const where = predicate.sql ? ` WHERE ${predicate.sql}` : ''
    const values: unknown[] = [...predicate.values, page.limit + 1]
    const [rawRows, fields] = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)}${where} ORDER BY ${predicate.orderBy} LIMIT ?`,
      values,
    )
    const hasMore = rawRows.length > page.limit
    const selected = rawRows.slice(0, page.limit)
    const rows = predicate.reverseResults ? selected.reverse() : selected
    const fieldList = Array.isArray(fields) ? (fields as Array<{ name?: unknown }>) : []
    return keysetPage(
      fieldList.length > 0 ? fieldList.map((field) => String(field.name)) : undefined,
      rows,
      page.pagination,
      hasMore,
    )
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

function firstStableKey(rows: Array<Record<string, unknown>>): string[] | undefined {
  const firstName = rows[0]?.key_name
  if (typeof firstName !== 'string' || firstName.length === 0) return undefined
  return rows
    .filter((row) => row.key_name === firstName)
    .sort((left, right) => Number(left.ordinal_position) - Number(right.ordinal_position))
    .map((row) => String(row.column_name))
}

function keysetPage(
  fields: string[] | undefined,
  rows: Array<Record<string, unknown>>,
  pagination: Extract<RowPagination, { mode: 'keyset' }>,
  hasMore: boolean,
): RowPage {
  const first = rows[0]
  const last = rows.at(-1)
  const hasInputCursor = pagination.values !== undefined
  return {
    columns: fields ?? Object.keys(first ?? {}),
    rows,
    paginationMode: 'keyset',
    nextCursor: last && (pagination.direction === 'backward' || hasMore)
      ? cursorFor(last, pagination.key, 'forward')
      : null,
    previousCursor: first && (pagination.direction === 'forward' ? hasInputCursor : hasMore)
      ? cursorFor(first, pagination.key, 'backward')
      : null,
  }
}

function cursorFor(row: Record<string, unknown>, key: string[], direction: 'forward' | 'backward'): string {
  return encodeKeysetCursor({ key, values: key.map((column) => cursorValue(row[column])), direction })
}

function cursorValue(value: unknown): KeysetCursorValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  throw new DatabaseConnectionError()
}
