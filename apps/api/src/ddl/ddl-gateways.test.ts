import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type {
  PostgresClientFactory,
  PostgresClientLike,
} from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { DdlServiceError } from './ddl-service.js'
import {
  MysqlDdlGateway,
  type MysqlDdlConnectionFactory,
  type MysqlDdlConnectionLike,
} from './mysql-ddl-gateway.js'
import { PostgresDdlGateway } from './postgres-ddl-gateway.js'

const postgresConnection: ResolvedConnection = {
  id: 'pg-1', name: 'PG', engine: 'postgres', host: 'db.internal', port: 5432,
  database: 'app', username: 'admin', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}

const mysqlConnection: ResolvedConnection = {
  ...postgresConnection, id: 'my-1', name: 'MySQL', engine: 'mysql', port: 3306,
}

class TestSocket extends Duplex {
  override _read(): void {}
  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }
}

describe('PostgresDdlGateway', () => {
  it('查詢版本並在同一SSH連線交易執行所有statement', async () => {
    const query = vi.fn(async (input: string | { text: string }) => (typeof input === 'string' ? input : input.text) === 'SHOW server_version'
      ? { rows: [{ server_version: '17.5' }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    const end = vi.fn(async () => undefined)
    const client: PostgresClientLike = { connect: vi.fn(async () => undefined), query, end }
    const createClient = vi.fn<PostgresClientFactory>(() => client)
    const socket = new TestSocket()
    const gateway = new PostgresDdlGateway(createClient, { open: vi.fn(async () => socket) })

    await expect(gateway.serverVersion(postgresConnection)).resolves.toBe('17.5')
    await gateway.execute(postgresConnection, ['ALTER TABLE a', 'ALTER TABLE b'], { transactional: true })

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SHOW server_version', 'BEGIN', 'ALTER TABLE a', 'ALTER TABLE b', 'COMMIT',
    ])
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ stream: expect.any(Function) }))
    expect(end).toHaveBeenCalledTimes(2)
    expect(socket.destroyed).toBe(true)
  })

  it('交易失敗rollback並只回安全錯誤', async () => {
    const query = vi.fn(async (input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text
      if (sql === 'ALTER TABLE broken') throw new Error('secret syntax details')
      return { rows: [], rowCount: 0 }
    })
    const client: PostgresClientLike = {
      connect: vi.fn(async () => undefined), query, end: vi.fn(async () => undefined),
    }
    const gateway = new PostgresDdlGateway(() => client)

    await expect(gateway.execute(
      postgresConnection,
      ['ALTER TABLE broken'],
      { transactional: true },
    )).rejects.toEqual(new DdlServiceError('DDL_FAILED'))
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ALTER TABLE broken', 'ROLLBACK'])
  })
})

describe('MysqlDdlGateway', () => {
  it('查詢版本並依序非交易執行statement', async () => {
    const query = vi.fn(async (sql: string): Promise<[unknown, unknown]> => sql === 'SELECT VERSION() AS dbweb_version'
      ? [[{ dbweb_version: '8.4.5' }], []]
      : [{ affectedRows: 0 }, []])
    const end = vi.fn(async () => undefined)
    const client: MysqlDdlConnectionLike = { query, end }
    const createConnection: MysqlDdlConnectionFactory = vi.fn(async () => client)
    const socket = new TestSocket()
    const gateway = new MysqlDdlGateway(createConnection, { open: vi.fn(async () => socket) })

    await expect(gateway.serverVersion(mysqlConnection)).resolves.toBe('8.4.5')
    await gateway.execute(mysqlConnection, ['ALTER TABLE a', 'ALTER TABLE b'], { transactional: false })

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT VERSION() AS dbweb_version', 'ALTER TABLE a', 'ALTER TABLE b',
    ])
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ stream: socket }))
    expect(end).toHaveBeenCalledTimes(2)
    expect(socket.destroyed).toBe(true)
  })

  it('driver錯誤安全化且不繼續後續statement', async () => {
    const client: MysqlDdlConnectionLike = {
      query: vi.fn(async (sql: string): Promise<[unknown, unknown]> => {
        if (sql === 'ALTER TABLE broken') throw new Error('database-secret')
        return [{ affectedRows: 0 }, []]
      }),
      end: vi.fn(async () => undefined),
    }
    const gateway = new MysqlDdlGateway(async () => client)

    await expect(gateway.execute(
      mysqlConnection,
      ['ALTER TABLE broken', 'ALTER TABLE skipped'],
      { transactional: false },
    )).rejects.toEqual(new DdlServiceError('DDL_FAILED'))
    expect(client.query).toHaveBeenCalledTimes(1)
  })
})
