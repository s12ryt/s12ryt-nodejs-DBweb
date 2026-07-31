import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { PostgresClientFactory } from '../connections/postgres-connector.js'
import type { SqlDumpManifest } from './sql-dump-manifest.js'
import { PostgresSqlRestoreCatalogGateway } from './postgres-sql-restore-catalog-gateway.js'
import {
  MysqlSqlRestoreCatalogGateway,
  type MysqlSqlRestoreCatalogConnection,
  type MysqlSqlRestoreCatalogConnectionFactory,
} from './mysql-sql-restore-catalog-gateway.js'

describe('SQL restore catalog gateways', () => {
  it('reads PostgreSQL target catalog objects without using the source database', async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql === 'SHOW server_version') return { rows: [{ server_version: '9.6.24' }], rowCount: 1 }
        return {
          rows: [
            { dbweb_kind: 'schema', dbweb_schema: 'public', dbweb_name: 'public' },
            { dbweb_kind: 'table', dbweb_schema: 'public', dbweb_name: 'orders' },
            { dbweb_kind: 'view', dbweb_schema: 'public', dbweb_name: 'orders_view' },
          ],
          rowCount: 3,
        }
      }),
      end: vi.fn(async () => undefined),
    }
    const createClient = vi.fn<PostgresClientFactory>(() => client as never)
    const gateway = new PostgresSqlRestoreCatalogGateway(createClient)

    await expect(gateway.serverVersion(connection('postgres'), 'restore_db')).resolves.toBe('9.6.24')
    await expect(gateway.listExistingObjectIds(connection('postgres'), 'restore_db', manifest('postgres')))
      .resolves.toEqual(['schema:public', 'table:public.orders'])
    expect(createClient.mock.calls.every(([config]) => config.database === 'restore_db')).toBe(true)
    expect(client.end).toHaveBeenCalledTimes(2)
  })

  it('reads MySQL target catalog objects through fixed aliases', async () => {
    const client: MysqlSqlRestoreCatalogConnection = {
      query: vi.fn(async (sql: string, values?: unknown[]): Promise<[unknown, unknown]> => {
        if (sql.startsWith('SELECT VERSION')) return [[{ dbweb_version: '5.6.51' }], []]
        expect(values).toEqual(Array(7).fill('restore_db'))
        return [[
          { dbweb_kind: 'table', dbweb_schema: 'restore_db', dbweb_name: 'orders' },
          { dbweb_kind: 'event', dbweb_schema: 'restore_db', dbweb_name: 'nightly' },
        ], []]
      }),
      end: vi.fn(async () => undefined),
    }
    const createConnection = vi.fn<MysqlSqlRestoreCatalogConnectionFactory>(async () => client)
    const gateway = new MysqlSqlRestoreCatalogGateway(createConnection)

    await expect(gateway.serverVersion(connection('mysql'), 'restore_db')).resolves.toBe('5.6.51')
    await expect(gateway.listExistingObjectIds(connection('mysql'), 'restore_db', manifest('mysql')))
      .resolves.toEqual(['table:restore_db.orders'])
    expect(createConnection.mock.calls.every(([options]) => options.database === 'restore_db')).toBe(true)
    expect(client.end).toHaveBeenCalledTimes(2)
  })
})

function manifest(engine: 'postgres' | 'mysql'): SqlDumpManifest {
  const schema = engine === 'postgres' ? 'public' : 'restore_db'
  return {
    format: 'dbweb-sql-dump', version: 1, engine, serverVersion: '1', database: 'source_db',
    scope: { kind: 'database' }, entries: [], objects: [
      {
        id: `schema:${schema}`, kind: 'schema', schema, name: schema, dependencies: [],
        createCommands: [{ kind: 'create-schema', name: schema }],
        dropCommand: { kind: 'drop-schema', name: schema, confirmed: true },
      },
      {
        id: `table:${schema}.orders`, kind: 'table', schema, name: 'orders', dependencies: [],
        createCommands: [{
          kind: 'create-table', schema, name: 'orders',
          columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
        }],
        dropCommand: { kind: 'drop-table', schema, name: 'orders', confirmed: true },
      },
    ],
  }
}

function connection(engine: 'postgres' | 'mysql'): ResolvedConnection {
  return {
    id: 'c1', name: 'source', engine, host: 'db.test', port: engine === 'postgres' ? 5432 : 3306,
    database: 'source_db', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
    keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
  }
}
