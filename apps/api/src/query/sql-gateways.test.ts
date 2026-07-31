import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type {
  MysqlConnectionFactory,
  MysqlConnectionLike,
} from '../connections/mysql-connector.js'
import type { PostgresClientFactory } from '../connections/postgres-connector.js'
import { MysqlSqlGateway } from './mysql-sql-gateway.js'
import { PostgresSqlGateway } from './postgres-sql-gateway.js'

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

describe('PostgresSqlGateway', () => {
  it('傳遞 AbortSignal 與 timeout，整理多 statement 結果並關閉 client', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce([
        { rows: [{ first: 1 }], fields: [{ name: 'first' }], rowCount: 1 },
        { rows: [{ second: 2 }], fields: [{ name: 'second' }], rowCount: 1 },
      ])
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresSqlGateway(() => client)
    const controller = new AbortController()

    await expect(
      gateway.execute(connection, {
        sql: 'SELECT 1; SELECT 2',
        timeoutMs: 30_000,
        maxRows: 1001,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ columns: ['first', 'second'], rows: [{ first: 1 }, { second: 2 }], affectedRows: 2 })
    expect(query).toHaveBeenNthCalledWith(1, 'SET statement_timeout = 30000')
    expect(query).toHaveBeenNthCalledWith(2, {
      text: 'SELECT 1; SELECT 2',
      signal: controller.signal,
    })
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('透過 SSH channel 查詢並在完成後釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const client = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }),
      end: vi.fn(),
    }
    const factory = vi.fn<PostgresClientFactory>(() => client)
    const gateway = new PostgresSqlGateway(factory, { open: vi.fn(async () => channel) })

    await gateway.execute({ ...connection, ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } }, {
      sql: 'SELECT 1', timeoutMs: 30_000, maxRows: 1001, signal: new AbortController().signal,
    })

    expect(factory.mock.calls[0]?.[0].stream?.()).toBe(channel)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('唯讀查詢在唯讀交易中執行並提交', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: 1 }], fields: [{ name: 'value' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresSqlGateway(() => client)

    await gateway.execute(connection, {
      sql: 'SELECT 1', timeoutMs: 30_000, maxRows: 1001,
      signal: new AbortController().signal, readOnly: true,
    })

    expect(query.mock.calls.map(([statement]) =>
      typeof statement === 'string' ? statement : statement.text)).toEqual([
      'SET statement_timeout = 30000',
      'BEGIN READ ONLY',
      'SELECT 1',
      'COMMIT',
    ])
  })
})

describe('MysqlSqlGateway', () => {
  it('啟用多語句並在 abort 時 destroy driver connection', async () => {
    const controller = new AbortController()
    const query = vi.fn(
      async () =>
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const client = { query, end: vi.fn(), destroy: vi.fn() }
    const createConnection = vi.fn(async () => client)
    const gateway = new MysqlSqlGateway(createConnection)
    const pending = gateway.execute({ ...connection, engine: 'mysql', port: 3306 }, {
      sql: 'SELECT SLEEP(30)',
      timeoutMs: 30_000,
      maxRows: 1001,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ message: 'DATABASE_CONNECTION_FAILED' })
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ multipleStatements: true }))
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('透過 SSH channel 查詢並在完成後釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const client: MysqlConnectionLike = {
      query: vi.fn<MysqlConnectionLike['query']>(async () => [[], []]),
      end: vi.fn(),
      destroy: vi.fn(),
    }
    const factory = vi.fn<MysqlConnectionFactory>(async () => client)
    const gateway = new MysqlSqlGateway(factory, { open: vi.fn(async () => channel) })

    await gateway.execute({ ...connection, engine: 'mysql', ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } }, {
      sql: 'SELECT 1', timeoutMs: 30_000, maxRows: 1001, signal: new AbortController().signal,
    })

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ stream: channel }))
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('唯讀查詢停用多語句並在唯讀交易中執行', async () => {
    const query = vi
      .fn<MysqlConnectionLike['query']>()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ value: 1 }], [{ name: 'value' }]])
      .mockResolvedValueOnce([[], []])
    const client: MysqlConnectionLike = { query, end: vi.fn(), destroy: vi.fn() }
    const factory = vi.fn<MysqlConnectionFactory>(async () => client)
    const gateway = new MysqlSqlGateway(factory)

    await gateway.execute({ ...connection, engine: 'mysql', port: 3306 }, {
      sql: 'SELECT 1', timeoutMs: 30_000, maxRows: 1001,
      signal: new AbortController().signal, readOnly: true,
    })

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ multipleStatements: false }))
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      'START TRANSACTION READ ONLY',
      'SELECT 1',
      'COMMIT',
    ])
  })
})
