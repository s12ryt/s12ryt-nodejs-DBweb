import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MysqlConnectionFactory } from '../connections/mysql-connector.js'
import type { PostgresClientFactory } from '../connections/postgres-connector.js'
import { MysqlDatabaseGateway } from './mysql-database-gateway.js'
import { PostgresDatabaseGateway } from './postgres-database-gateway.js'

const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Main',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'app',
  username: 'reader',
  password: 'secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
}

describe('PostgresDatabaseGateway', () => {
  it('以參數查詢 metadata，並在完成後關閉 client', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ table_schema: 'public', table_name: 'orders', table_type: 'BASE TABLE' }] })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDatabaseGateway(() => client)

    await expect(gateway.listTables(connection, "public' OR true --")).resolves.toEqual([
      { schema: 'public', name: 'orders', type: 'table' },
    ])

    expect(query).toHaveBeenCalledWith(expect.stringContaining('table_schema = $1'), ["public' OR true --"])
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('安全引用 schema/table，且 limit/offset 維持參數化', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 7 }], fields: [{ name: 'id' }] }))
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDatabaseGateway(() => client)

    await gateway.readRows(connection, {
      schema: 'odd"schema',
      table: 'order"items',
      limit: 20,
      pagination: { mode: 'offset', offset: 40 },
    })

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM "odd""schema"."order""items" LIMIT $1 OFFSET $2',
      [21, 40],
    )
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('優先使用primary key並以參數化複合keyset向前分頁', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { key_name: 'orders_pkey', primary_key: true, column_name: 'tenant_id', ordinal_position: 1 },
        { key_name: 'orders_pkey', primary_key: true, column_name: 'id', ordinal_position: 2 },
      ] })
      .mockResolvedValueOnce({
        rows: [
          { tenant_id: 'acme', id: 42 },
          { tenant_id: 'acme', id: 43 },
          { tenant_id: 'acme', id: 44 },
        ],
        fields: [{ name: 'tenant_id' }, { name: 'id' }],
      })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDatabaseGateway(() => client)

    await expect(gateway.findStableKey(connection, 'public', 'orders')).resolves.toEqual(['tenant_id', 'id'])
    const page = await gateway.readRows(connection, {
      schema: 'public',
      table: 'orders',
      limit: 2,
      pagination: {
        mode: 'keyset',
        key: ['tenant_id', 'id'],
        direction: 'forward',
        values: ['acme', 41],
      },
    })

    expect(query.mock.calls[1]).toEqual([
      'SELECT * FROM "public"."orders" WHERE ("tenant_id" > $1) OR ("tenant_id" = $2 AND "id" > $3) ORDER BY "tenant_id" ASC, "id" ASC LIMIT $4',
      ['acme', 'acme', 41, 3],
    ])
    expect(page).toMatchObject({
      paginationMode: 'keyset',
      rows: [{ tenant_id: 'acme', id: 42 }, { tenant_id: 'acme', id: 43 }],
      previousCursor: expect.any(String),
      nextCursor: expect.any(String),
    })
  })

  it('透過 SSH channel 瀏覽並在完成後釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const client = { connect: vi.fn(), query: vi.fn(async () => ({ rows: [] })), end: vi.fn() }
    const factory = vi.fn<PostgresClientFactory>(() => client)
    const gateway = new PostgresDatabaseGateway(factory, { open: vi.fn(async () => channel) })

    await gateway.listSchemas({ ...connection, ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } })

    expect(factory.mock.calls[0]?.[0].stream?.()).toBe(channel)
    expect(destroy).toHaveBeenCalledOnce()
  })
})

describe('MysqlDatabaseGateway', () => {
  it('安全引用 schema/table、參數化分頁，失敗時仍關閉 connection', async () => {
    const query = vi.fn().mockRejectedValue(new Error('driver leaked detail'))
    const client = { query, end: vi.fn() }
    const gateway = new MysqlDatabaseGateway(async () => client)

    await expect(
      gateway.readRows({ ...connection, engine: 'mysql', port: 3306 }, {
        schema: 'odd`schema',
        table: 'order`items',
        limit: 20,
        pagination: { mode: 'offset', offset: 40 },
      }),
    ).rejects.toMatchObject({ message: 'DATABASE_CONNECTION_FAILED' })

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM `odd``schema`.`order``items` LIMIT ? OFFSET ?',
      [21, 40],
    )
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('只選全部非空的unique key，並以反向keyset查詢後恢復顯示順序', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        key_name: 'uq_orders_code',
        primary_key: 0,
        column_name: 'code',
        ordinal_position: 1,
        nullable_column: 0,
      }], []])
      .mockResolvedValueOnce([[
        { code: 'c' },
        { code: 'b' },
        { code: 'a' },
      ], [{ name: 'code' }]])
    const client = { query, end: vi.fn() }
    const gateway = new MysqlDatabaseGateway(async () => client)
    const mysqlConnection = { ...connection, engine: 'mysql' as const, port: 3306 }

    await expect(gateway.findStableKey(mysqlConnection, 'app', 'orders')).resolves.toEqual(['code'])
    const page = await gateway.readRows(mysqlConnection, {
      schema: 'app',
      table: 'orders',
      limit: 2,
      pagination: { mode: 'keyset', key: ['code'], direction: 'backward', values: ['d'] },
    })

    expect(query.mock.calls[1]).toEqual([
      'SELECT * FROM `app`.`orders` WHERE (`code` < ?) ORDER BY `code` DESC LIMIT ?',
      ['d', 3],
    ])
    expect(page).toMatchObject({
      paginationMode: 'keyset',
      rows: [{ code: 'b' }, { code: 'c' }],
      previousCursor: expect.any(String),
      nextCursor: expect.any(String),
    })
  })

  it('透過 SSH channel 瀏覽並在失敗後仍釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const client = { query: vi.fn().mockRejectedValue(new Error('failed')), end: vi.fn() }
    const factory = vi.fn<MysqlConnectionFactory>(async () => client)
    const gateway = new MysqlDatabaseGateway(factory, { open: vi.fn(async () => channel) })

    await expect(gateway.listSchemas({ ...connection, engine: 'mysql', ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } })).rejects.toThrow('DATABASE_CONNECTION_FAILED')

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ stream: channel }))
    expect(destroy).toHaveBeenCalledOnce()
  })
})
