import type { Duplex, Readable } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2'

import { DatabaseConnectionError } from '../connections/connector-error.js'
import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { SqlStreamGateway } from './sql-query-service.js'

interface MysqlStreamingQuery {
  stream(options: { objectMode: true; highWaterMark: number }): Readable
}

export interface MysqlSqlStreamConnection {
  query(sql: string, callback: (error?: Error) => void): unknown
  query(sql: string): MysqlStreamingQuery
  end(callback: (error?: Error) => void): void
  destroy(): void
}

export type MysqlSqlStreamConnectionFactory = (
  options: MysqlClientOptions & { supportBigNumbers: true; bigNumberStrings: true; dateStrings: true },
) => Promise<MysqlSqlStreamConnection>
export type MysqlSqlRowStreamFactory = (
  connection: MysqlSqlStreamConnection,
  sql: string,
  highWaterMark: number,
) => Readable

export class MysqlSqlStreamGateway implements SqlStreamGateway {
  constructor(
    private readonly createConnection: MysqlSqlStreamConnectionFactory = connectMysql,
    private readonly createRowStream: MysqlSqlRowStreamFactory = (connection, sql, highWaterMark) =>
      connection.query(sql).stream({ objectMode: true, highWaterMark }),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async *stream(
    connection: ResolvedConnection,
    request: Parameters<SqlStreamGateway['stream']>[1],
  ): AsyncIterable<Record<string, unknown>> {
    let client: MysqlSqlStreamConnection | undefined
    let rowStream: Readable | undefined
    let socket: Duplex | undefined
    let committed = false
    const abortStream = () => rowStream?.destroy(new DatabaseConnectionError())
    try {
      validateRequest(request)
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection({
        ...mysqlClientOptions(connection, socket),
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      })
      await query(client, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await query(client, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      rowStream = this.createRowStream(client, request.sql, request.batchSize)
      request.signal.addEventListener('abort', abortStream, { once: true })
      for await (const row of rowStream) {
        throwIfAborted(request.signal)
        if (!row || typeof row !== 'object') throw new DatabaseConnectionError()
        yield row as Record<string, unknown>
      }
      await query(client, 'COMMIT')
      committed = true
    } catch {
      throw new DatabaseConnectionError()
    } finally {
      request.signal.removeEventListener('abort', abortStream)
      rowStream?.destroy()
      if (client && !committed) {
        try { await query(client, 'ROLLBACK') } catch { /* Cleanup must not replace the safe error. */ }
      }
      try { await end(client) } catch { client?.destroy() }
      socket?.destroy()
    }
  }
}

async function connectMysql(options: Parameters<MysqlSqlStreamConnectionFactory>[0]): Promise<MysqlSqlStreamConnection> {
  const connection = mysql.createConnection(options as ConnectionOptions) as unknown as MysqlSqlStreamConnection & {
    connect(callback: (error?: Error) => void): void
  }
  await new Promise<void>((resolve, reject) => {
    connection.connect((error) => error ? reject(error) : resolve())
  })
  return connection
}

function query(connection: MysqlSqlStreamConnection, statement: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.query(statement, (error) => error ? reject(error) : resolve())
  })
}

function end(connection?: MysqlSqlStreamConnection): Promise<void> {
  if (!connection) return Promise.resolve()
  return new Promise((resolve, reject) => {
    connection.end((error) => error ? reject(error) : resolve())
  })
}

function validateRequest(request: Parameters<SqlStreamGateway['stream']>[1]): void {
  if (
    request.readOnly !== true
    || !request.sql.trim()
    || !Number.isInteger(request.timeoutMs)
    || request.timeoutMs < 100
    || request.timeoutMs > 300_000
    || !Number.isInteger(request.batchSize)
    || request.batchSize < 1
    || request.batchSize > 10_000
  ) throw new DatabaseConnectionError()
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}
