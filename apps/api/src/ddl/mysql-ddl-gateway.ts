import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { DdlServiceError, type DdlGateway } from './ddl-service.js'

export interface MysqlDdlConnectionLike {
  query(sql: string): Promise<[unknown, unknown]>
  end(): Promise<void>
}

export type MysqlDdlConnectionFactory = (
  options: MysqlClientOptions,
) => Promise<MysqlDdlConnectionLike>

export class MysqlDdlGateway implements DdlGateway {
  constructor(
    private readonly createConnection: MysqlDdlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlDdlConnectionLike,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async serverVersion(connection: ResolvedConnection): Promise<string> {
    return this.withConnection(connection, async (client) => {
      const [rawRows] = await client.query('SELECT VERSION() AS dbweb_version')
      if (!Array.isArray(rawRows)) throw new DdlServiceError('DDL_FAILED')
      const version = (rawRows[0] as Record<string, unknown> | undefined)?.dbweb_version
      if (typeof version !== 'string' || !version) throw new DdlServiceError('DDL_FAILED')
      return version
    })
  }

  async execute(
    connection: ResolvedConnection,
    statements: string[],
    options: { transactional: boolean },
  ): Promise<void> {
    if (options.transactional) throw new DdlServiceError('DDL_FAILED')
    await this.withConnection(connection, async (client) => {
      for (const statement of statements) await client.query(statement)
    })
  }

  private async withConnection<T>(
    connection: ResolvedConnection,
    operation: (client: MysqlDdlConnectionLike) => Promise<T>,
  ): Promise<T> {
    let client: MysqlDdlConnectionLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
      return await operation(client)
    } catch {
      throw new DdlServiceError('DDL_FAILED')
    } finally {
      try {
        await client?.end()
      } catch {
        // Cleanup failures must not replace the DDL result.
      }
      socket?.destroy()
    }
  }
}
