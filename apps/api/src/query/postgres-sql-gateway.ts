import { Client } from 'pg'
import type { Duplex } from 'node:stream'

import { DatabaseConnectionError } from '../connections/connector-error.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
  type PostgresQueryResult,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { SqlGateway, SqlGatewayResult } from './sql-query-service.js'

export class PostgresSqlGateway implements SqlGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async execute(
    connection: ResolvedConnection,
    request: { sql: string; timeoutMs: number; maxRows: number; signal: AbortSignal },
  ): Promise<SqlGatewayResult> {
    let client: PostgresClientLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      await client.query(`SET statement_timeout = ${request.timeoutMs}`)
      const raw = await client.query({ text: request.sql, signal: request.signal })
      const results = Array.isArray(raw) ? raw : [raw]
      return collectPostgresResults(results, request.maxRows)
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

function collectPostgresResults(results: PostgresQueryResult[], maxRows: number): SqlGatewayResult {
  const columns: string[] = []
  const rows: Array<Record<string, unknown>> = []
  let affectedRows = 0
  for (const result of results) {
    for (const field of result.fields ?? []) {
      if (!columns.includes(field.name)) columns.push(field.name)
    }
    if (columns.length === 0 && result.rows[0]) {
      for (const name of Object.keys(result.rows[0])) if (!columns.includes(name)) columns.push(name)
    }
    const remaining = Math.max(0, maxRows - rows.length)
    rows.push(...result.rows.slice(0, remaining))
    affectedRows += result.rowCount ?? result.rows.length
  }
  return { columns, rows, affectedRows }
}
