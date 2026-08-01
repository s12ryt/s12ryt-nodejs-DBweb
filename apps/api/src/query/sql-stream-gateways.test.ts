import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  MysqlSqlStreamGateway,
  type MysqlSqlStreamConnection,
} from './mysql-sql-stream-gateway.js'
import {
  PostgresSqlStreamGateway,
  type PostgresSqlStreamClient,
} from './postgres-sql-stream-gateway.js'

const postgres: ResolvedConnection = {
  id: 'connection-1', name: 'Main', engine: 'postgres', host: 'localhost', port: 5432,
  database: 'app', username: 'reader', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
}

describe('PostgresSqlStreamGateway', () => {
  it('以cursor在唯讀交易內逐批輸出並提交', async () => {
    const statements: string[] = []
    const cursor = {
      read: vi.fn().mockResolvedValueOnce([{ id: '1' }, { id: '2' }]).mockResolvedValueOnce([]),
      close: vi.fn(),
    }
    const client = {
      connect: vi.fn(),
      query: vi.fn((input: string | { marker: 'cursor' }) => {
        if (typeof input === 'string') { statements.push(input); return Promise.resolve({ rows: [] }) }
        return cursor
      }) as unknown as PostgresSqlStreamClient['query'],
      end: vi.fn(),
    }
    const createCursor = vi.fn(() => ({ marker: 'cursor' }) as never)
    const gateway = new PostgresSqlStreamGateway(() => client, createCursor)

    const rows = []
    for await (const row of gateway.stream(postgres, {
      sql: 'SELECT id FROM reports', timeoutMs: 30_000, batchSize: 500,
      signal: new AbortController().signal, readOnly: true,
    })) rows.push(row)

    expect(rows).toEqual([{ id: '1' }, { id: '2' }])
    expect(statements).toEqual([
      'SET statement_timeout = 30000',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT',
    ])
    expect(createCursor).toHaveBeenCalledWith('SELECT id FROM reports', [])
    expect(cursor.read).toHaveBeenCalledWith(500)
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('consumer提早結束時關cursor並rollback', async () => {
    const statements: string[] = []
    const cursor = { read: vi.fn().mockResolvedValue([{ id: '1' }]), close: vi.fn() }
    const client = {
      connect: vi.fn(),
      query: vi.fn((input: string | object) => {
        if (typeof input === 'string') { statements.push(input); return Promise.resolve({ rows: [] }) }
        return cursor
      }) as unknown as PostgresSqlStreamClient['query'],
      end: vi.fn(),
    }
    const gateway = new PostgresSqlStreamGateway(() => client, () => ({}) as never)

    for await (const row of gateway.stream(postgres, {
      sql: 'SELECT id FROM reports', timeoutMs: 30_000, batchSize: 100,
      signal: new AbortController().signal, readOnly: true,
    })) { void row; break }

    expect(cursor.close).toHaveBeenCalledOnce()
    expect(statements).toContain('ROLLBACK')
  })
})

describe('MysqlSqlStreamGateway', () => {
  it('以query stream背壓輸出並在唯讀consistent snapshot提交', async () => {
    const statements: string[] = []
    const query = vi.fn((sql: string, values?: unknown[] | ((error?: Error) => void), callback?: (error?: Error) => void) => {
        statements.push(sql)
        queueMicrotask(() => (typeof values === 'function' ? values : callback)?.())
        return { stream: () => Readable.from([], { objectMode: true }) }
      })
    const client: MysqlSqlStreamConnection = {
      query: query as unknown as MysqlSqlStreamConnection['query'],
      end: vi.fn((callback: (error?: Error) => void) => callback()),
      destroy: vi.fn(),
    }
    const createRowStream = vi.fn(() => Readable.from([{ id: '1' }, { id: '2' }], { objectMode: true }))
    const gateway = new MysqlSqlStreamGateway(async () => client, createRowStream)

    const rows = []
    for await (const row of gateway.stream({ ...postgres, engine: 'mysql', port: 3306 }, {
      sql: 'SELECT id FROM reports', timeoutMs: 30_000, batchSize: 250,
      signal: new AbortController().signal, readOnly: true,
    })) rows.push(row)

    expect(rows).toEqual([{ id: '1' }, { id: '2' }])
    expect(statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'COMMIT',
    ])
    expect(createRowStream).toHaveBeenCalledWith(client, 'SELECT id FROM reports', 250)
  })
})
