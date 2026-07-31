import { randomBytes } from 'node:crypto'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import {
  mysqlClientOptions,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { NativeAccountGatewayError } from './native-account-gateway-error.js'
import type {
  ActualNativeAccount,
  CreateNativeAccountRequest,
  NativeAccountGateway,
} from './native-account-service.js'
import type { NativeAccountIdentity } from './native-account-policy.js'

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function accountSql(identity: Extract<NativeAccountIdentity, { engine: 'mysql' }>): string {
  return `${quoteLiteral(identity.username)}@${quoteLiteral(identity.host)}`
}

function versionAtLeast(version: string, major: number, minor: number, patch = 0): boolean {
  const match = version.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  const actual = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : [5, 6, 0]
  return actual[0]! > major ||
    (actual[0] === major && actual[1]! > minor) ||
    (actual[0] === major && actual[1] === minor && actual[2]! >= patch)
}

export class MysqlNativeAccountGateway implements NativeAccountGateway {
  constructor(
    private readonly createConnection: MysqlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listAccounts(connection: ResolvedConnection): Promise<ActualNativeAccount[]> {
    return await this.withClient(connection, async (client) => {
      const version = await this.serverVersion(client)
      const supportsLock = versionAtLeast(version, 5, 7, 6)
      const [rows] = await client.query(`
        SELECT User AS dbweb_username,
               Host AS dbweb_host,
               password_expired AS dbweb_password_expired,
               max_user_connections AS dbweb_connection_limit,
               Super_priv AS dbweb_superuser
               ${supportsLock ? ', account_locked AS dbweb_account_locked' : ''}
        FROM mysql.user
        ORDER BY User, Host
      `)
      return rows.map((row) => {
        const username = String(row.dbweb_username)
        return {
          identity: {
            engine: 'mysql' as const,
            username,
            host: String(row.dbweb_host),
          },
          canLogin: !supportsLock || row.dbweb_account_locked !== 'Y',
          passwordExpired: row.dbweb_password_expired === 'Y',
          connectionLimit: Number(row.dbweb_connection_limit),
          systemAccount: row.dbweb_superuser === 'Y' ||
            ['mysql.infoschema', 'mysql.session', 'mysql.sys', 'root'].includes(username),
        }
      })
    })
  }

  async createAccount(
    connection: ResolvedConnection,
    request: CreateNativeAccountRequest,
  ): Promise<void> {
    if (request.identity.engine !== 'mysql') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    const identity = request.identity
    await this.withClient(connection, async (client) => {
      const version = await this.serverVersion(client)
      const lock = versionAtLeast(version, 5, 7, 6)
        ? request.canLogin ? ' ACCOUNT UNLOCK' : ' ACCOUNT LOCK'
        : ''
      const connectionLimit = request.connectionLimit === -1 ? 0 : request.connectionLimit
      if (versionAtLeast(version, 5, 7)) {
        await client.query(
          `CREATE USER ${accountSql(identity)} IDENTIFIED BY ${quoteLiteral(request.password)} WITH MAX_USER_CONNECTIONS ${connectionLimit}${lock}`,
        )
        return
      }

      await client.query(
        `CREATE USER ${accountSql(identity)} IDENTIFIED BY ${quoteLiteral(request.password)}`,
      )
      await client.query(
        `UPDATE mysql.user SET max_user_connections = ${connectionLimit} WHERE User = ${quoteLiteral(identity.username)} AND Host = ${quoteLiteral(identity.host)}`,
      )
      await client.query('FLUSH PRIVILEGES')
    })
  }

  async rotatePassword(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void> {
    if (identity.engine !== 'mysql') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    const mysqlIdentity = identity
    await this.withClient(connection, async (client) => {
      const version = await this.serverVersion(client)
      await client.query(versionAtLeast(version, 5, 7, 6)
        ? `ALTER USER ${accountSql(mysqlIdentity)} IDENTIFIED BY ${quoteLiteral(password)}`
        : `SET PASSWORD FOR ${accountSql(mysqlIdentity)} = PASSWORD(${quoteLiteral(password)})`)
    })
  }

  async setAccountEnabled(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    enabled: boolean,
    password: string,
  ): Promise<void> {
    if (identity.engine !== 'mysql') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    const mysqlIdentity = identity
    await this.withClient(connection, async (client) => {
      const version = await this.serverVersion(client)
      if (versionAtLeast(version, 5, 7, 6)) {
        await client.query(`ALTER USER ${accountSql(mysqlIdentity)} ACCOUNT ${enabled ? 'UNLOCK' : 'LOCK'}`)
      } else {
        const effectivePassword = enabled ? password : randomBytes(32).toString('base64url')
        await client.query(
          `SET PASSWORD FOR ${accountSql(mysqlIdentity)} = PASSWORD(${quoteLiteral(effectivePassword)})`,
        )
      }
    })
  }

  async deleteAccount(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
  ): Promise<void> {
    if (identity.engine !== 'mysql') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient(connection, async (client) => {
      await client.query(`DROP USER ${accountSql(identity)}`)
    })
  }

  async verifyCredential(
    connection: ResolvedConnection,
    database: string,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void> {
    if (identity.engine !== 'mysql') throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    await this.withClient({
      ...connection,
      database,
      username: identity.username,
      password,
    }, async (client) => {
      await client.query('SELECT 1')
    })
  }

  private async serverVersion(client: MysqlConnectionLike): Promise<string> {
    const [rows] = await client.query('SELECT VERSION() AS dbweb_version')
    const version = rows[0]?.dbweb_version
    if (typeof version !== 'string') throw new Error('invalid version')
    return version
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    operation: (client: MysqlConnectionLike) => Promise<T>,
  ): Promise<T> {
    let socket: Awaited<ReturnType<DatabaseSocketProvider['open']>>
    let client: MysqlConnectionLike | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
      return await operation(client)
    } catch {
      throw new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED')
    } finally {
      await client?.end().catch(() => undefined)
      socket?.destroy()
    }
  }
}
