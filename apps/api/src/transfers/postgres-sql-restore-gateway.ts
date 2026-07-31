import type { Duplex } from 'node:stream'

import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { postgresClientConfig, type PostgresClientFactory, type PostgresClientLike } from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { detectDdlCapabilities } from '../ddl/ddl-capabilities.js'
import {
  SqlRestoreExecutionError,
  type SqlRestoreExecutionGateway,
  type SqlRestoreSession,
} from './sql-restore-service.js'

export type PostgresSqlRestoreDataLoader = (
  client: PostgresClientLike,
  objectId: string,
  entryPath: string,
  content: AsyncIterable<Buffer>,
  signal: AbortSignal,
) => Promise<void>

export class PostgresSqlRestoreGateway implements SqlRestoreExecutionGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
    private readonly loadData: PostgresSqlRestoreDataLoader = async () => {
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    },
  ) {}

  async open(connection: ResolvedConnection, targetDatabase: string): Promise<SqlRestoreSession> {
    let socket: Duplex | undefined
    let client: PostgresClientLike | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig({ ...connection, database: targetDatabase }, socket))
      await client.connect()
      const versionResult = await client.query('SHOW server_version')
      const version = versionResult.rows[0]?.server_version
      if (typeof version !== 'string' || !version) throw new Error('INVALID_VERSION')
      return new PostgresSqlRestoreSession(
        client,
        socket,
        detectDdlCapabilities('postgres', version),
        this.loadData,
      )
    } catch {
      try { await client?.end() } catch { /* Preserve the safe open error. */ }
      socket?.destroy()
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    }
  }
}

class PostgresSqlRestoreSession implements SqlRestoreSession {
  readonly transactional = true
  private applied = 0

  constructor(
    private readonly client: PostgresClientLike,
    private readonly socket: Duplex | undefined,
    readonly capabilities: ReturnType<typeof detectDdlCapabilities>,
    private readonly loadData: PostgresSqlRestoreDataLoader,
  ) {}

  async begin(): Promise<void> {
    await this.safeQuery('BEGIN')
  }

  async executeStatement(sql: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SqlRestoreExecutionError('RESTORE_CANCELLED', this.applied)
    await this.safeQuery(sql)
    this.applied += 1
  }

  async restoreData(
    objectId: string,
    entryPath: string,
    content: AsyncIterable<Buffer>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new SqlRestoreExecutionError('RESTORE_CANCELLED', this.applied)
    try {
      await this.loadData(this.client, objectId, entryPath, content, signal)
      this.applied += 1
    } catch (error) {
      if (error instanceof SqlRestoreExecutionError && error.code === 'RESTORE_CANCELLED') throw error
      throw new SqlRestoreExecutionError('RESTORE_FAILED', 0)
    }
  }

  async commit(): Promise<void> {
    await this.safeQuery('COMMIT')
  }

  async rollback(): Promise<void> {
    try { await this.client.query('ROLLBACK') } catch { /* Preserve the original restore error. */ }
  }

  async close(): Promise<void> {
    try { await this.client.end() } finally { this.socket?.destroy() }
  }

  appliedSteps(): number {
    return this.applied
  }

  private async safeQuery(sql: string): Promise<void> {
    try {
      await this.client.query(sql)
    } catch {
      throw new SqlRestoreExecutionError('RESTORE_FAILED', 0)
    }
  }
}
