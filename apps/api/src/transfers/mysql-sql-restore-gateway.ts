import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import { detectDdlCapabilities } from '../ddl/ddl-capabilities.js'
import {
  SqlRestoreExecutionError,
  type SqlRestoreExecutionGateway,
  type SqlRestoreSession,
} from './sql-restore-service.js'

export interface MysqlSqlRestoreConnection {
  query(sql: string): Promise<[unknown, unknown]>
  end(): Promise<void>
}

export type MysqlSqlRestoreConnectionFactory = (
  options: MysqlClientOptions,
) => Promise<MysqlSqlRestoreConnection>

export type MysqlSqlRestoreDataLoader = (
  client: MysqlSqlRestoreConnection,
  objectId: string,
  entryPath: string,
  content: AsyncIterable<Buffer>,
  signal: AbortSignal,
) => Promise<void>

export class MysqlSqlRestoreGateway implements SqlRestoreExecutionGateway {
  constructor(
    private readonly createConnection: MysqlSqlRestoreConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlSqlRestoreConnection,
    private readonly socketProvider?: DatabaseSocketProvider,
    private readonly loadData: MysqlSqlRestoreDataLoader = async () => {
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    },
  ) {}

  async open(connection: ResolvedConnection, targetDatabase: string): Promise<SqlRestoreSession> {
    let socket: Duplex | undefined
    let client: MysqlSqlRestoreConnection | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions({ ...connection, database: targetDatabase }, socket))
      const [rawRows] = await client.query('SELECT VERSION() AS dbweb_version')
      if (!Array.isArray(rawRows)) throw new Error('INVALID_VERSION')
      const version = (rawRows[0] as Record<string, unknown> | undefined)?.dbweb_version
      if (typeof version !== 'string' || !version) throw new Error('INVALID_VERSION')
      return new MysqlSqlRestoreSession(
        client,
        socket,
        detectDdlCapabilities('mysql', version),
        this.loadData,
      )
    } catch {
      try { await client?.end() } catch { /* Preserve the safe open error. */ }
      socket?.destroy()
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    }
  }
}

class MysqlSqlRestoreSession implements SqlRestoreSession {
  readonly transactional = false
  private applied = 0

  constructor(
    private readonly client: MysqlSqlRestoreConnection,
    private readonly socket: Duplex | undefined,
    readonly capabilities: ReturnType<typeof detectDdlCapabilities>,
    private readonly loadData: MysqlSqlRestoreDataLoader,
  ) {}

  async begin(): Promise<void> {}

  async executeStatement(sql: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SqlRestoreExecutionError('RESTORE_CANCELLED', this.applied)
    try {
      await this.client.query(sql)
      this.applied += 1
    } catch {
      throw new SqlRestoreExecutionError('RESTORE_FAILED', this.applied)
    }
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
      throw new SqlRestoreExecutionError('RESTORE_FAILED', this.applied)
    }
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  async close(): Promise<void> {
    try { await this.client.end() } finally { this.socket?.destroy() }
  }

  appliedSteps(): number {
    return this.applied
  }
}
