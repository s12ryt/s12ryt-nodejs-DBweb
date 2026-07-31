import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseConnector } from './connection-service.js'
import type { DatabaseSocketProvider } from './database-socket-provider.js'
import type { ResolvedConnection } from './connection-types.js'
import { DatabaseConnectionError } from './connector-error.js'

export interface MysqlConnectionLike {
  query(query: string, values?: unknown[]): Promise<[Array<Record<string, unknown>>, unknown]>
  end(): Promise<void>
  destroy?(): void
}

export interface MysqlClientOptions {
  host: string
  port: number
  database: string
  user: string
  password: string
  connectTimeout: number
  enableKeepAlive: boolean
  keepAliveInitialDelay: number
  ssl?: TlsConnectionOptions
  multipleStatements?: boolean
  stream?: Duplex
}

export type MysqlConnectionFactory = (options: MysqlClientOptions) => Promise<MysqlConnectionLike>

function tlsOptions(connection: ResolvedConnection): TlsConnectionOptions | undefined {
  const { tls } = connection
  if (tls.mode === 'disable') return undefined
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

export function mysqlClientOptions(connection: ResolvedConnection, socket?: Duplex): MysqlClientOptions {
  const ssl = tlsOptions(connection)
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectTimeout: 10_000,
    enableKeepAlive: connection.keepAlive.enabled,
    keepAliveInitialDelay: connection.keepAlive.intervalMs,
    ...(ssl ? { ssl } : {}),
    ...(socket ? { stream: socket } : {}),
  }
}

export class MysqlConnector implements DatabaseConnector {
  constructor(
    private readonly createConnection: MysqlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlConnectionLike,
    private readonly now: () => number = () => performance.now(),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async test(connection: ResolvedConnection): Promise<{ latencyMs: number; serverVersion: string }> {
    let client: MysqlConnectionLike | undefined
    let socket: Duplex | undefined
    const startedAt = this.now()
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
      const [rows] = await client.query('SELECT VERSION() AS server_version')
      const serverVersion = rows[0]?.server_version
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
