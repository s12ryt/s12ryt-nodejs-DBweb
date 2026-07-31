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
import type { SqlGateway, SqlGatewayResult } from './sql-query-service.js'

export class MysqlSqlGateway implements SqlGateway {
  constructor(
    private readonly createConnection: MysqlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlConnectionLike,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async execute(
    connection: ResolvedConnection,
    request: {
      sql: string
      timeoutMs: number
      maxRows: number
      signal: AbortSignal
      readOnly?: boolean
    },
  ): Promise<SqlGatewayResult> {
    let client: MysqlConnectionLike | undefined
    let socket: Duplex | undefined
    let transactionStarted = false
    const abort = () => client?.destroy?.()
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection({
        ...mysqlClientOptions(connection, socket),
        multipleStatements: !request.readOnly,
      })
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.readOnly) {
        await client.query('START TRANSACTION READ ONLY')
        transactionStarted = true
      }
      const [rawRows, rawFields] = await client.query(request.sql)
      if (transactionStarted) {
        await client.query('COMMIT')
        transactionStarted = false
      }
      return collectMysqlResults(rawRows, rawFields, request.maxRows)
    } catch {
      if (transactionStarted) {
        try {
          await client?.query('ROLLBACK')
        } catch {
          // Rollback failure must not expose or replace the safe query error.
        }
      }
      throw new DatabaseConnectionError()
    } finally {
      request.signal.removeEventListener('abort', abort)
      try {
        await client?.end()
      } catch {
        // Cleanup errors must not replace the query result or its safe error.
      }
      socket?.destroy()
    }
  }
}

function collectMysqlResults(
  rawRows: Array<Record<string, unknown>>,
  rawFields: unknown,
  maxRows: number,
): SqlGatewayResult {
  const groups = rawRows.every(Array.isArray)
    ? (rawRows as unknown as Array<Array<Record<string, unknown>>>)
    : [rawRows]
  const rows = groups.flatMap((group) => group).slice(0, maxRows)
  const fieldGroups = Array.isArray(rawFields) && rawFields.every(Array.isArray)
    ? (rawFields as Array<Array<{ name?: unknown }>>)
    : [Array.isArray(rawFields) ? (rawFields as Array<{ name?: unknown }>) : []]
  const columns: string[] = []
  for (const field of fieldGroups.flat()) {
    const name = String(field.name)
    if (!columns.includes(name)) columns.push(name)
  }
  if (columns.length === 0 && rows[0]) columns.push(...Object.keys(rows[0]))
  return { columns, rows, affectedRows: rows.length }
}
