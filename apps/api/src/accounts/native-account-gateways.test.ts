import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type {
  PostgresClientFactory,
  PostgresClientLike,
} from '../connections/postgres-connector.js'
import type {
  MysqlConnectionFactory,
  MysqlConnectionLike,
} from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { NativeAccountGatewayError } from './native-account-gateway-error.js'
import { MysqlNativeAccountGateway } from './mysql-native-account-gateway.js'
import { PostgresNativeAccountGateway } from './postgres-native-account-gateway.js'

const postgresConnection: ResolvedConnection = {
  id: 'pg-1', name: 'PG', engine: 'postgres', host: 'db.internal', port: 5432,
  database: 'app', username: 'dbweb_runtime', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const mysqlConnection: ResolvedConnection = {
  ...postgresConnection, id: 'my-1', name: 'MySQL', engine: 'mysql', port: 3306,
}

class TestSocket extends Duplex {
  override _read(): void {}
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback()
  }
}

describe('PostgresNativeAccountGateway', () => {
  it('lists role state and creates a restricted login role over the shared socket path', async () => {
    const query = vi.fn(async (input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text
      return sql.includes('FROM pg_catalog.pg_roles') ? {
          rows: [
            { dbweb_username: 'postgres', dbweb_can_login: true, dbweb_password_expired: false, dbweb_connection_limit: -1, dbweb_superuser: true },
            { dbweb_username: 'reporter', dbweb_can_login: true, dbweb_password_expired: true, dbweb_connection_limit: 4, dbweb_superuser: false },
          ],
        } : { rows: [] }
    })
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query,
      end: vi.fn(async () => undefined),
    }
    const createClient = vi.fn<PostgresClientFactory>(() => client)
    const socket = new TestSocket()
    const gateway = new PostgresNativeAccountGateway(
      createClient,
      { open: vi.fn(async () => socket) },
    )

    await expect(gateway.listAccounts(postgresConnection)).resolves.toEqual([
      expect.objectContaining({ identity: { engine: 'postgres', username: 'postgres' }, systemAccount: true }),
      expect.objectContaining({ identity: { engine: 'postgres', username: 'reporter' }, passwordExpired: true, connectionLimit: 4, systemAccount: false }),
    ])
    await gateway.createAccount(postgresConnection, {
      identity: { engine: 'postgres', username: 'report"er' },
      password: "safe'password-value",
      canLogin: true,
      connectionLimit: 4,
    })
    expect(query).toHaveBeenLastCalledWith(
      'CREATE ROLE "report""er" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD \'safe\'\'password-value\'',
    )
    expect(socket.destroyed).toBe(true)
  })

  it('rotates passwords and returns only a safe gateway error on driver failure', async () => {
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => { throw new Error('database-secret') }),
      end: vi.fn(async () => undefined),
    }
    const gateway = new PostgresNativeAccountGateway(() => client)
    await expect(
      gateway.rotatePassword(
        postgresConnection,
        { engine: 'postgres', username: 'reporter' },
        'new-password-value',
      ),
    ).rejects.toEqual(new NativeAccountGatewayError('NATIVE_ACCOUNT_FAILED'))
  })
})

describe('MysqlNativeAccountGateway', () => {
  it('uses MySQL 5.6-compatible account metadata and password rotation', async () => {
    const query = vi.fn(async (sql: string): Promise<[Array<Record<string, unknown>>, unknown]> => {
      if (sql === 'SELECT VERSION() AS dbweb_version') return [[{ dbweb_version: '5.6.51' }], []]
      if (sql.includes('FROM mysql.user')) {
        return [[{
          dbweb_username: 'reporter', dbweb_host: '10.%', dbweb_password_expired: 'N',
          dbweb_connection_limit: 3, dbweb_superuser: 'N',
        }], []]
      }
      return [[], []]
    })
    const client: MysqlConnectionLike = { query, end: vi.fn(async () => undefined) }
    const createConnection = vi.fn<MysqlConnectionFactory>(async () => client)
    const gateway = new MysqlNativeAccountGateway(createConnection)

    await expect(gateway.listAccounts(mysqlConnection)).resolves.toEqual([
      expect.objectContaining({
        identity: { engine: 'mysql', username: 'reporter', host: '10.%' },
        connectionLimit: 3,
        systemAccount: false,
      }),
    ])
    await gateway.rotatePassword(
      mysqlConnection,
      { engine: 'mysql', username: 'reporter', host: '10.%' },
      "new'password-value",
    )
    expect(query).toHaveBeenLastCalledWith(
      "SET PASSWORD FOR 'reporter'@'10.%' = PASSWORD('new''password-value')",
    )

    await gateway.setAccountEnabled(
      mysqlConnection,
      { engine: 'mysql', username: 'reporter', host: '10.%' },
      false,
      'stored-password-value',
    )
    const disableSql = String(query.mock.calls.at(-1)?.[0])
    expect(disableSql).toMatch(/^SET PASSWORD FOR 'reporter'@'10\.%' = PASSWORD\('[A-Za-z0-9_-]{43}'\)$/)
    expect(disableSql).not.toContain('stored-password-value')

    await gateway.setAccountEnabled(
      mysqlConnection,
      { engine: 'mysql', username: 'reporter', host: '10.%' },
      true,
      'stored-password-value',
    )
    expect(query).toHaveBeenLastCalledWith(
      "SET PASSWORD FOR 'reporter'@'10.%' = PASSWORD('stored-password-value')",
    )
  })

  it('uses modern metadata and creates an unlocked restricted MySQL 8.4 account', async () => {
    const query = vi.fn(async (sql: string): Promise<[Array<Record<string, unknown>>, unknown]> =>
      sql === 'SELECT VERSION() AS dbweb_version'
        ? [[{ dbweb_version: '8.4.5' }], []]
        : [[], []])
    const client: MysqlConnectionLike = { query, end: vi.fn(async () => undefined) }
    const gateway = new MysqlNativeAccountGateway(async () => client)

    await gateway.createAccount(mysqlConnection, {
      identity: { engine: 'mysql', username: 'reporter', host: '%' },
      password: 'strong-password-value',
      canLogin: true,
      connectionLimit: 5,
    })
    expect(query).toHaveBeenLastCalledWith(
      "CREATE USER 'reporter'@'%' IDENTIFIED BY 'strong-password-value' WITH MAX_USER_CONNECTIONS 5 ACCOUNT UNLOCK",
    )

    await gateway.createAccount(mysqlConnection, {
      identity: { engine: 'mysql', username: 'unlimited', host: '%' },
      password: 'strong-password-value',
      canLogin: true,
      connectionLimit: -1,
    })
    expect(query).toHaveBeenLastCalledWith(
      "CREATE USER 'unlimited'@'%' IDENTIFIED BY 'strong-password-value' WITH MAX_USER_CONNECTIONS 0 ACCOUNT UNLOCK",
    )

    await gateway.setAccountEnabled(
      mysqlConnection,
      { engine: 'mysql', username: 'reporter', host: '%' },
      false,
      'stored-password-value',
    )
    expect(query).toHaveBeenLastCalledWith("ALTER USER 'reporter'@'%' ACCOUNT LOCK")
  })
})
