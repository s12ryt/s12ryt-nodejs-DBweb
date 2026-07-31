import type { Duplex } from 'node:stream'

import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { DdlServiceError, type DdlGateway } from './ddl-service.js'

export class PostgresDdlGateway implements DdlGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async serverVersion(connection: ResolvedConnection): Promise<string> {
    return this.withClient(connection, async (client) => {
      const result = await client.query('SHOW server_version')
      const version = result.rows[0]?.server_version
      if (typeof version !== 'string' || !version) throw new DdlServiceError('DDL_FAILED')
      return version
    })
  }

  async execute(
    connection: ResolvedConnection,
    statements: string[],
    options: { transactional: boolean },
  ): Promise<void> {
    await this.withClient(connection, async (client) => {
      if (options.transactional) await client.query('BEGIN')
      try {
        for (const statement of statements) await client.query(statement)
        if (options.transactional) await client.query('COMMIT')
      } catch {
        if (options.transactional) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Preserve the original execution failure.
          }
        }
        throw new DdlServiceError('DDL_FAILED')
      }
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    operation: (client: PostgresClientLike) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClientLike | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
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
