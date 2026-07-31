import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { NativeAccountGatewayError } from './native-account-gateway-error.js'
import type {
  ActualNativeAccount,
  CreateNativeAccountRequest,
  NativeAccountGateway,
} from './native-account-service.js'
import type { NativeAccountIdentity } from './native-account-policy.js'

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export class PostgresNativeAccountGateway implements NativeAccountGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listAccounts(connection: ResolvedConnection): Promise<ActualNativeAccount[]> {
    return await this.withClient(connection, async (client) => {
      const result = await client.query(`
        SELECT rolname AS dbweb_username,
               rolcanlogin AS dbweb_can_login,
               (rolvaliduntil IS NOT NULL AND rolvaliduntil <= CURRENT_TIMESTAMP) AS dbweb_password_expired,
               rolconnlimit AS dbweb_connection_limit,
               rolsuper AS dbweb_superuser
        FROM pg_catalog.pg_roles
        ORDER BY rolname
      `)
      return result.rows.map((row) => {
        const username = String(row.dbweb_username)
        return {
          identity: { engine: 'postgres' as const, username },
          canLogin: row.dbweb_can_login === true,
          passwordExpired: row.dbweb_password_expired === true,
          connectionLimit: Number(row.dbweb_connection_limit),
          systemAccount: row.dbweb_superuser === true || username.startsWith('pg_'),
        }
      })
    })
  }

  async createAccount(
    connection: ResolvedConnection,
    request: CreateNativeAccountRequest,
  ): Promise<void> {
    if (request.identity.engine !== 'postgres') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    const login = request.canLogin ? 'LOGIN' : 'NOLOGIN'
    await this.withClient(connection, async (client) => {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(request.identity.username)} ${login} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${request.connectionLimit} PASSWORD ${quoteLiteral(request.password)}`,
      )
    })
  }

  async rotatePassword(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void> {
    if (identity.engine !== 'postgres') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient(connection, async (client) => {
      await client.query(
        `ALTER ROLE ${quoteIdentifier(identity.username)} PASSWORD ${quoteLiteral(password)}`,
      )
    })
  }

  async setAccountEnabled(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    enabled: boolean,
    password: string,
  ): Promise<void> {
    void password
    if (identity.engine !== 'postgres') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient(connection, async (client) => {
      await client.query(`ALTER ROLE ${quoteIdentifier(identity.username)} ${enabled ? 'LOGIN' : 'NOLOGIN'}`)
    })
  }

  async deleteAccount(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
  ): Promise<void> {
    if (identity.engine !== 'postgres') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient(connection, async (client) => {
      await client.query(`DROP ROLE ${quoteIdentifier(identity.username)}`)
    })
  }

  async verifyCredential(
    connection: ResolvedConnection,
    database: string,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void> {
    if (identity.engine !== 'postgres') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient({
      ...connection,
      database,
      username: identity.username,
      password,
    }, async (client) => {
      await client.query('SELECT 1')
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    operation: (client: PostgresClientLike) => Promise<T>,
  ): Promise<T> {
    let socket: Awaited<ReturnType<DatabaseSocketProvider['open']>>
    let client: PostgresClientLike | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      return await operation(client)
    } catch {
      throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    } finally {
      await client?.end().catch(() => undefined)
      socket?.destroy()
    }
  }
}
