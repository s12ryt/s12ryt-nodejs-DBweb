import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { Duplex } from 'node:stream'

import { Client, type ClientConfig } from 'pg'

import type { DatabaseConnector } from './connection-service.js'
import type { DatabaseSocketProvider } from './database-socket-provider.js'
import type { ResolvedConnection } from './connection-types.js'
import { DatabaseConnectionError } from './connector-error.js'

export interface PostgresClientLike {
  connect(): Promise<unknown>
  query(query: string, values?: unknown[]): Promise<PostgresQueryResult>
  query(query: { text: string; signal?: AbortSignal }): Promise<PostgresQueryResult | PostgresQueryResult[]>
  end(): Promise<void>
}

export interface PostgresQueryResult {
  rows: Array<Record<string, unknown>>
  fields?: Array<{ name: string }>
  rowCount?: number | null
}

export type PostgresClientFactory = (config: ClientConfig) => PostgresClientLike

function tlsOptions(connection: ResolvedConnection): false | TlsConnectionOptions {
  const { tls } = connection
  if (tls.mode === 'disable') return false
  const common = {
    ...(tls.ca ? { ca: tls.ca } : {}),
    ...(tls.certificate ? { cert: tls.certificate } : {}),
    ...(tls.privateKey ? { key: tls.privateKey } : {}),
  }
  if (tls.mode === 'require' || tls.mode === 'prefer') {
    return { ...common, rejectUnauthorized: false }
  }
  if (tls.mode === 'verify-ca') {
    return { ...common, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  }
  return { ...common, rejectUnauthorized: true }
}

export function postgresClientConfig(connection: ResolvedConnection, socket?: Duplex): ClientConfig {
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl: tlsOptions(connection),
    keepAlive: connection.keepAlive.enabled,
    keepAliveInitialDelayMillis: connection.keepAlive.intervalMs,
    connectionTimeoutMillis: 10_000,
    ...(socket ? { stream: () => socket } : {}),
  }
}

export class PostgresConnector implements DatabaseConnector {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly now: () => number = () => performance.now(),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async test(connection: ResolvedConnection): Promise<{ latencyMs: number; serverVersion: string }> {
    let socket: Duplex | undefined
    let client: PostgresClientLike | undefined
    const startedAt = this.now()
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      const result = await client.query('SHOW server_version')
      const serverVersion = result.rows[0]?.server_version
      if (typeof serverVersion !== 'string') throw new Error('invalid server response')
      return { latencyMs: Math.max(0, Math.round(this.now() - startedAt)), serverVersion }
    } catch {
      throw new DatabaseConnectionError()
    } finally {
      await client?.end().catch(() => undefined)
      socket?.destroy()
    }
  }
}
