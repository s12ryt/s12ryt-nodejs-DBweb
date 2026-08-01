import type { Duplex } from 'node:stream'

import { Client, type ClientConfig } from 'pg'
import Cursor from 'pg-cursor'

import { DatabaseConnectionError } from '../connections/connector-error.js'
import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { postgresClientConfig } from '../connections/postgres-connector.js'
import type { SqlStreamGateway } from './sql-query-service.js'

export interface PostgresSqlStreamCursor {
  read(maxRows: number): Promise<Array<Record<string, unknown>>>
  close(): Promise<void>
}

export interface PostgresSqlStreamClient {
  connect(): Promise<unknown>
  query(sql: string): Promise<unknown>
  query(cursor: PostgresSqlStreamCursor): PostgresSqlStreamCursor
  end(): Promise<void>
}

export type PostgresSqlStreamClientFactory = (config: ClientConfig) => PostgresSqlStreamClient
export type PostgresSqlStreamCursorFactory = (sql: string, values: unknown[]) => PostgresSqlStreamCursor

export class PostgresSqlStreamGateway implements SqlStreamGateway {
  constructor(
    private readonly createClient: PostgresSqlStreamClientFactory = (config) =>
      new Client(config) as unknown as PostgresSqlStreamClient,
    private readonly createCursor: PostgresSqlStreamCursorFactory = (sql, values) =>
      new Cursor<Record<string, unknown>>(sql, values),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async *stream(
    connection: ResolvedConnection,
    request: Parameters<SqlStreamGateway['stream']>[1],
  ): AsyncIterable<Record<string, unknown>> {
    let client: PostgresSqlStreamClient | undefined
    let cursor: PostgresSqlStreamCursor | undefined
    let socket: Duplex | undefined
    let committed = false
    let exhausted = false
    const abortCursor = () => { void cursor?.close().catch(() => undefined) }
    try {
      validateRequest(request)
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      await client.query(`SET statement_timeout = ${request.timeoutMs}`)
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      cursor = client.query(this.createCursor(request.sql, []))
      request.signal.addEventListener('abort', abortCursor, { once: true })
      while (true) {
        throwIfAborted(request.signal)
        const rows = await cursor.read(request.batchSize)
        throwIfAborted(request.signal)
        if (rows.length === 0) { exhausted = true; break }
        for (const row of rows) yield row
      }
      await client.query('COMMIT')
      committed = true
    } catch {
      throw new DatabaseConnectionError()
    } finally {
      request.signal.removeEventListener('abort', abortCursor)
      if (cursor && !exhausted) {
        try { await cursor.close() } catch { /* Cleanup must not replace the safe error. */ }
      }
      if (client && !committed) {
        try { await client.query('ROLLBACK') } catch { /* Cleanup must not replace the safe error. */ }
      }
      try { await client?.end() } catch { /* Cleanup must not replace the result. */ }
      socket?.destroy()
    }
  }
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
