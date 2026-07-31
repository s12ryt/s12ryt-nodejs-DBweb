import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from './connection-types.js'
import {
  MysqlConnector,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from './mysql-connector.js'
import {
  PostgresConnector,
  type PostgresClientFactory,
  type PostgresClientLike,
} from './postgres-connector.js'

const baseConnection: ResolvedConnection = {
  id: 'connection-id',
  name: 'Test',
  engine: 'postgres',
  host: 'db.example.test',
  port: 5432,
  database: 'app',
  username: 'reader',
  password: 'secret',
  tls: { mode: 'verify-full', ca: 'CA', certificate: 'CERT', privateKey: 'KEY' },
  keepAlive: { enabled: true, intervalMs: 300_000 },
}

describe('PostgresConnector', () => {
  it('映射 verify-full TLS、TCP keepalive 並回傳版本', async () => {
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ server_version: '9.6.24' }] })),
      end: vi.fn(async () => undefined),
    }
    const factory = vi.fn<PostgresClientFactory>(() => client)
    const connector = new PostgresConnector(factory, () => 100)

    const result = await connector.test(baseConnection)

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db.example.test',
        keepAlive: true,
        keepAliveInitialDelayMillis: 300_000,
        ssl: expect.objectContaining({ rejectUnauthorized: true, ca: 'CA', cert: 'CERT', key: 'KEY' }),
      }),
    )
    expect(result).toEqual({ latencyMs: 0, serverVersion: '9.6.24' })
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('連線失敗仍關閉 client 且不把密碼加入錯誤訊息', async () => {
    const client: PostgresClientLike = {
      connect: vi.fn(async () => {
        throw new Error('authentication failed for secret')
      }),
      query: vi.fn(),
      end: vi.fn(async () => undefined),
    }
    const connector = new PostgresConnector(() => client)

    await expect(connector.test(baseConnection)).rejects.toThrow('DATABASE_CONNECTION_FAILED')
    await expect(client.end).toHaveBeenCalledOnce()
  })

  it('將 SSH channel 注入 driver 並於完成後釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const socketProvider = { open: vi.fn(async () => channel) }
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ server_version: '16.0' }] })),
      end: vi.fn(async () => undefined),
    }
    const factory = vi.fn<PostgresClientFactory>(() => client)
    const connector = new PostgresConnector(factory, () => 100, socketProvider)

    await connector.test({ ...baseConnection, ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } })

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ stream: expect.any(Function) }))
    expect(factory.mock.calls[0]?.[0].stream?.()).toBe(channel)
    expect(destroy).toHaveBeenCalledOnce()
  })
})

describe('MysqlConnector', () => {
  it('映射 verify-ca TLS、TCP keepalive 並回傳版本', async () => {
    const connection: MysqlConnectionLike = {
      query: vi.fn<MysqlConnectionLike['query']>(async () => [[{ server_version: '5.6.51' }], []]),
      end: vi.fn(async () => undefined),
    }
    const factory = vi.fn<MysqlConnectionFactory>(async () => connection)
    const connector = new MysqlConnector(factory, () => 200)

    const result = await connector.test({
      ...baseConnection,
      engine: 'mysql',
      port: 3306,
      tls: { ...baseConnection.tls, mode: 'verify-ca' },
    })

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        enableKeepAlive: true,
        keepAliveInitialDelay: 300_000,
        ssl: expect.objectContaining({ rejectUnauthorized: true, ca: 'CA', cert: 'CERT', key: 'KEY' }),
      }),
    )
    const ssl = factory.mock.calls[0]?.[0].ssl
    expect(ssl?.checkServerIdentity).toBeTypeOf('function')
    expect(result).toEqual({ latencyMs: 0, serverVersion: '5.6.51' })
    expect(connection.end).toHaveBeenCalledOnce()
  })

  it('將 SSH channel 注入 driver 並於完成後釋放', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroy = vi.spyOn(channel, 'destroy')
    const socketProvider = { open: vi.fn(async () => channel) }
    const connection: MysqlConnectionLike = {
      query: vi.fn<MysqlConnectionLike['query']>(async () => [[{ server_version: '8.0' }], []]),
      end: vi.fn(async () => undefined),
    }
    const factory = vi.fn<MysqlConnectionFactory>(async () => connection)
    const connector = new MysqlConnector(factory, () => 100, socketProvider)

    await connector.test({ ...baseConnection, engine: 'mysql', ssh: { enabled: true, host: 'ssh', port: 22, username: 'u', password: 'p' } })

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ stream: channel }))
    expect(destroy).toHaveBeenCalledOnce()
  })
})
