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
  RowPagination,
  RowPage,
} from './database-explorer.js'
import { buildKeysetPredicate, encodeKeysetCursor, type KeysetCursorValue } from './keyset-pagination.js'

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

  async findStableKey(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<string[] | undefined> {
    const result = await this.query(
      connection,
      `SELECT index_class.relname AS key_name,
              idx.indisprimary AS primary_key,
              attribute.attname AS column_name,
              key_column.ordinality AS ordinal_position
       FROM pg_catalog.pg_index idx
       JOIN pg_catalog.pg_class table_class ON table_class.oid = idx.indrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
       JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
       CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
       JOIN pg_catalog.pg_attribute attribute
         ON attribute.attrelid = table_class.oid AND attribute.attnum = key_column.attnum
       WHERE namespace.nspname = $1 AND table_class.relname = $2
         AND idx.indisunique
         AND idx.indpred IS NULL
         AND idx.indexprs IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(idx.indkey) AS nullable_key(attnum)
           JOIN pg_catalog.pg_attribute nullable_attribute
             ON nullable_attribute.attrelid = table_class.oid
            AND nullable_attribute.attnum = nullable_key.attnum
           WHERE NOT nullable_attribute.attnotnull
         )
       ORDER BY idx.indisprimary DESC, index_class.relname, key_column.ordinality`,
      [schema, table],
    )
    return firstStableKey(result.rows)
  }

  async readRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; pagination: RowPagination },
  ): Promise<RowPage> {
    if (page.pagination.mode === 'keyset') {
      return this.readKeysetRows(connection, { ...page, pagination: page.pagination })
    }
    const result = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)} LIMIT $1 OFFSET $2`,
      [page.limit + 1, page.pagination.offset],
    )
    const rows = result.rows.slice(0, page.limit)
    return {
      columns: result.fields?.map((field) => field.name) ?? Object.keys(result.rows[0] ?? {}),
      rows,
      paginationMode: 'offset',
      nextOffset: result.rows.length > page.limit ? page.pagination.offset + rows.length : null,
      warning: 'OFFSET_PAGINATION',
    }
  }

  private async readKeysetRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; pagination: Extract<RowPagination, { mode: 'keyset' }> },
  ): Promise<RowPage> {
    const predicate = page.pagination.values
      ? buildKeysetPredicate('postgres', page.pagination.key, page.pagination.values, page.pagination.direction)
      : {
          sql: '',
          values: [] as KeysetCursorValue[],
          orderBy: page.pagination.key.map((column) => `${quoteIdentifier(column)} ${page.pagination.direction === 'forward' ? 'ASC' : 'DESC'}`).join(', '),
          reverseResults: page.pagination.direction === 'backward',
        }
    const values: unknown[] = [...predicate.values, page.limit + 1]
    const where = predicate.sql ? ` WHERE ${predicate.sql}` : ''
    const result = await this.query(
      connection,
      `SELECT * FROM ${quoteIdentifier(page.schema)}.${quoteIdentifier(page.table)}${where} ORDER BY ${predicate.orderBy} LIMIT $${values.length}`,
      values,
    )
    const hasMore = result.rows.length > page.limit
    const selected = result.rows.slice(0, page.limit)
    const rows = predicate.reverseResults ? selected.reverse() : selected
    return keysetPage(result.fields?.map((field) => field.name), rows, page.pagination, hasMore)
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

function mapColumn(row: Record<string, unknown>): DatabaseColumn {
  return {
    name: String(row.column_name),
    dataType: String(row.data_type),
    nullable: row.is_nullable === 'YES',
    primaryKey: row.primary_key === true,
    ...(row.column_default == null ? {} : { defaultValue: String(row.column_default) }),
  }
}
