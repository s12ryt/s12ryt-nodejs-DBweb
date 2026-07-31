import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { PostgresClientFactory } from '../connections/postgres-connector.js'
import { PostgresSqlRestoreGateway } from './postgres-sql-restore-gateway.js'
import {
  MysqlSqlRestoreGateway,
  type MysqlSqlRestoreConnection,
  type MysqlSqlRestoreConnectionFactory,
} from './mysql-sql-restore-gateway.js'

describe('SQL restore execution gateways', () => {
  it('uses one PostgreSQL target database connection and transaction for SQL and data', async () => {
    const queries: string[] = []
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql === 'SHOW server_version') return { rows: [{ server_version: '17.5' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      end: vi.fn(async () => undefined),
    }
    const loadData = vi.fn(async (_client, objectId: string, entryPath: string, content: AsyncIterable<Buffer>) => {
      let value = ''
      for await (const chunk of content) value += chunk.toString('utf8')
      queries.push(`DATA ${objectId} ${entryPath} ${value}`)
    })
    const createClient = vi.fn<PostgresClientFactory>(() => client as never)
    const gateway = new PostgresSqlRestoreGateway(createClient, undefined, loadData)
    const session = await gateway.open(connection('postgres'), 'restore_db')

    await session.begin()
    await session.executeStatement('CREATE TABLE example(id bigint)', new AbortController().signal)
    await session.restoreData('table:public.example', 'data/example.ndjson', chunks('row'), new AbortController().signal)
    await session.commit()
    await session.close()

    expect(createClient.mock.calls[0]?.[0]).toMatchObject({ database: 'restore_db' })
    expect(queries).toEqual([
      'SHOW server_version', 'BEGIN', 'CREATE TABLE example(id bigint)',
      'DATA table:public.example data/example.ndjson row', 'COMMIT',
    ])
    expect(session.transactional).toBe(true)
    expect(session.capabilities.version.major).toBe(17)
    expect(session.appliedSteps()).toBe(2)
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('rolls back PostgreSQL without exposing driver errors and closes the SSH channel', async () => {
    const socket = new EventEmitter() as never
    Object.assign(socket as object, { destroy: vi.fn() })
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql === 'SHOW server_version') return { rows: [{ server_version: '9.6.24' }], rowCount: 1 }
        if (sql === 'BROKEN') throw new Error('driver-secret')
        return { rows: [], rowCount: 0 }
      }),
      end: vi.fn(async () => undefined),
    }
    const gateway = new PostgresSqlRestoreGateway(
      (() => client) as never,
      { open: vi.fn(async () => socket) },
      vi.fn(),
    )
    const session = await gateway.open(connection('postgres', true), 'restore_db')
    await session.begin()
    await expect(session.executeStatement('BROKEN', new AbortController().signal)).rejects.toThrow('RESTORE_FAILED')
    await session.rollback()
    await session.close()
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect((socket as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledOnce()
  })

  it('executes MySQL steps non-transactionally and preserves the applied count', async () => {
    const queries: string[] = []
    const client: MysqlSqlRestoreConnection = {
      query: vi.fn(async (sql: string): Promise<[unknown, unknown]> => {
        queries.push(sql)
        if (sql.startsWith('SELECT VERSION')) return [[{ dbweb_version: '8.4.0' }], []]
        if (sql === 'BROKEN') throw new Error('driver-secret')
        return [{ affectedRows: 0 }, []]
      }),
      end: vi.fn(async () => undefined),
    }
    const createConnection = vi.fn<MysqlSqlRestoreConnectionFactory>(async () => client)
    const gateway = new MysqlSqlRestoreGateway(
      createConnection,
      undefined,
      vi.fn(async () => undefined),
    )
    const session = await gateway.open(connection('mysql'), 'restore_db')
    await session.begin()
    await session.executeStatement('CREATE TABLE example(id bigint)', new AbortController().signal)
    await expect(session.executeStatement('BROKEN', new AbortController().signal)).rejects.toThrow('RESTORE_FAILED')
    await session.rollback()
    await session.close()

    expect(queries).toEqual(['SELECT VERSION() AS dbweb_version', 'CREATE TABLE example(id bigint)', 'BROKEN'])
    expect(session.transactional).toBe(false)
    expect(session.appliedSteps()).toBe(1)
    expect(client.end).toHaveBeenCalledOnce()
  })
})

function connection(engine: 'postgres' | 'mysql', ssh = false): ResolvedConnection {
  return {
    id: 'c1', name: 'source', engine, host: 'db.test', port: engine === 'postgres' ? 5432 : 3306,
    database: 'source_db', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
    keepAlive: { enabled: false, intervalMs: 300_000 },
    ssh: ssh
      ? { enabled: true, host: 'ssh.test', port: 22, username: 'operator', password: 'ssh-secret' }
      : { enabled: false },
  }
}

async function* chunks(value: string): AsyncIterable<Buffer> {
  yield Buffer.from(value)
}
