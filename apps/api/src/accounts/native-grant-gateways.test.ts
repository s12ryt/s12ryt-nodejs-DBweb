import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MysqlConnectionLike } from '../connections/mysql-connector.js'
import type { PostgresClientLike } from '../connections/postgres-connector.js'
import {
  NativeGrantGatewayError,
  type NativeGrantGateway,
} from './native-grant-gateway.js'
import { MysqlNativeGrantGateway } from './mysql-native-grant-gateway.js'
import { PostgresNativeGrantGateway } from './postgres-native-grant-gateway.js'

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

describe('PostgresNativeGrantGateway', () => {
  it('reads direct grants from the target database and executes them transactionally', async () => {
    const query = vi.fn(async (input: string | { text: string; signal?: AbortSignal }) => {
      const sql = typeof input === 'string' ? input : input.text
      if (sql.includes("'database' AS dbweb_scope")) {
        return { rows: [{ dbweb_scope: 'database', dbweb_database: 'analytics', dbweb_privilege: 'CONNECT' }] }
      }
      if (sql.includes("'schema' AS dbweb_scope")) {
        return { rows: [{ dbweb_scope: 'schema', dbweb_database: 'analytics', dbweb_schema: 'reporting', dbweb_privilege: 'USAGE' }] }
      }
      if (sql.includes("'table' AS dbweb_scope")) {
        return { rows: [{ dbweb_scope: 'table', dbweb_database: 'analytics', dbweb_schema: 'reporting', dbweb_table: 'orders', dbweb_privilege: 'SELECT' }] }
      }
      return { rows: [] }
    })
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query: query as PostgresClientLike['query'],
      end: vi.fn(async () => undefined),
    }
    const socket = new TestSocket()
    const createClient = vi.fn(() => client)
    const gateway: NativeGrantGateway = new PostgresNativeGrantGateway(
      createClient,
      { open: vi.fn(async () => socket) },
    )

    await expect(gateway.listGrants(
      postgresConnection,
      'analytics',
      { engine: 'postgres', username: 'reader' },
    )).resolves.toEqual([
      { scope: 'database', database: 'analytics', privileges: ['connect'] },
      { scope: 'schema', database: 'analytics', schema: 'reporting', privileges: ['usage'] },
      { scope: 'table', database: 'analytics', schema: 'reporting', table: 'orders', privileges: ['select'] },
    ])
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ database: 'analytics' }))

    await expect(gateway.execute(postgresConnection, 'analytics', [
      'GRANT CONNECT ON DATABASE "analytics" TO "reader"',
      'GRANT USAGE ON SCHEMA "reporting" TO "reader"',
    ])).resolves.toEqual({ appliedCount: 2 })
    expect(query.mock.calls.slice(-4).map(([sql]) => sql)).toEqual([
      'BEGIN',
      'GRANT CONNECT ON DATABASE "analytics" TO "reader"',
      'GRANT USAGE ON SCHEMA "reporting" TO "reader"',
      'COMMIT',
    ])
    expect(socket.destroyed).toBe(true)
  })

  it('rolls back PostgreSQL grants and reports no applied statements on failure', async () => {
    const query = vi.fn(async (input: string | { text: string; signal?: AbortSignal }) => {
      const sql = typeof input === 'string' ? input : input.text
      if (sql.startsWith('REVOKE')) throw new Error('driver-secret')
      return { rows: [] }
    })
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query: query as PostgresClientLike['query'],
      end: vi.fn(async () => undefined),
    }
    const gateway = new PostgresNativeGrantGateway(() => client)

    await expect(gateway.execute(postgresConnection, 'analytics', [
      'REVOKE SELECT ON TABLE "public"."orders" FROM "reader"',
    ])).rejects.toEqual(new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0))
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
  })
})

describe('MysqlNativeGrantGateway', () => {
  it('reads direct database and table grants from structured grant tables', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]): Promise<[Array<Record<string, unknown>>, unknown]> => {
      void values
      if (sql.includes('FROM mysql.db')) return [[{
        dbweb_database: 'app\\_data', dbweb_select: 'Y', dbweb_insert: 'N',
        dbweb_update: 'N', dbweb_delete: 'N', dbweb_create: 'Y', dbweb_drop: 'N',
        dbweb_references: 'N', dbweb_index: 'N', dbweb_alter: 'N',
      }], []]
      if (sql.includes('FROM mysql.tables_priv')) return [[{
        dbweb_database: 'app_data', dbweb_table: 'orders', dbweb_privileges: 'Select,Insert',
      }], []]
      return [[], []]
    })
    const client: MysqlConnectionLike = { query, end: vi.fn(async () => undefined) }
    const gateway = new MysqlNativeGrantGateway(async () => client)

    await expect(gateway.listGrants(
      mysqlConnection,
      'app_data',
      { engine: 'mysql', username: 'reader', host: '10.%' },
    )).resolves.toEqual([
      { scope: 'database', database: 'app_data', privileges: ['select', 'create'] },
      { scope: 'table', database: 'app_data', table: 'orders', privileges: ['select', 'insert'] },
    ])
    expect(query.mock.calls[0]?.[1]).toEqual(['reader', '10.%'])
  })

  it('stops MySQL execution after the first failure and reports partial progress', async () => {
    const query = vi.fn(async (sql: string): Promise<[Array<Record<string, unknown>>, unknown]> => {
      if (sql.includes('ON `app`.`blocked`')) throw new Error('driver-secret')
      return [[], []]
    })
    const client: MysqlConnectionLike = { query, end: vi.fn(async () => undefined) }
    const gateway = new MysqlNativeGrantGateway(async () => client)

    await expect(gateway.execute(mysqlConnection, 'app', [
      "GRANT SELECT ON `app`.`orders` TO 'reader'@'%'",
      "GRANT SELECT ON `app`.`blocked` TO 'reader'@'%'",
      "GRANT SELECT ON `app`.`never-run` TO 'reader'@'%'",
    ])).rejects.toEqual(new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 1, 1))
    expect(query).toHaveBeenCalledTimes(2)
  })
})
