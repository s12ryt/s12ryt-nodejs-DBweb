import { PassThrough, Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { MysqlTransferDataGateway } from './mysql-transfer-data-gateway.js'
import {
  PostgresTransferDataGateway,
  type PostgresTransferClient,
} from './postgres-transfer-data-gateway.js'
import { TransferDataError } from './transfer-data-gateway.js'

const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Primary',
  engine: 'postgres',
  host: 'db.example.test',
  port: 5432,
  database: 'app',
  username: 'dbweb',
  password: 'database-secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

const table: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
  ],
  uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
}

describe('PostgresTransferDataGateway', () => {
  it('streams multiple tables inside one repeatable read-only snapshot', async () => {
    const statements: string[] = []
    const cursors = [
      { read: vi.fn().mockResolvedValueOnce([{ id: '1', note: 'first' }]).mockResolvedValueOnce([]), close: vi.fn() },
      { read: vi.fn().mockResolvedValueOnce([{ id: '2', note: 'second' }]).mockResolvedValueOnce([]), close: vi.fn() },
    ]
    let cursorIndex = 0
    const client = {
      connect: vi.fn(),
      query: vi.fn((input: string | { marker: 'cursor' }) => {
        if (typeof input === 'string') { statements.push(input); return Promise.resolve({ rows: [] }) }
        return cursors[cursorIndex++]
      }) as unknown as PostgresTransferClient['query'],
      end: vi.fn(),
    }
    const gateway = new PostgresTransferDataGateway(
      () => client,
      () => ({ marker: 'cursor' }) as never,
    )

    const rows = []
    for await (const row of gateway.streamMany(connection, [
      { id: 'orders-a', request: { table, filters: [], batchSize: 100 } },
      { id: 'orders-b', request: { table, filters: [], batchSize: 100 } },
    ])) rows.push(row)

    expect(rows.map((value) => [value.id, value.row.id])).toEqual([
      ['orders-a', { kind: 'value', type: 'bigint', value: '1' }],
      ['orders-b', { kind: 'value', type: 'bigint', value: '2' }],
    ])
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'])
  })

  it('streams tagged rows through a repeatable read-only cursor transaction', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const cursor = {
      read: vi.fn()
        .mockResolvedValueOnce([
          { id: '9007199254740993', note: 'first' },
          { id: '9007199254740994', note: null },
        ])
        .mockResolvedValueOnce([]),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const query = vi.fn((input: string | { marker: 'cursor' }, values?: unknown[]) => {
      if (typeof input === 'string') {
        statements.push({ sql: input, ...(values ? { values } : {}) })
        return Promise.resolve({ rows: [] })
      }
      return cursor
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: query as unknown as PostgresTransferClient['query'],
      end: vi.fn().mockResolvedValue(undefined),
    }
    const createCursor = vi.fn(() => ({ marker: 'cursor' }) as never)
    const gateway = new PostgresTransferDataGateway(
      () => client,
      createCursor,
    )

    const rows = []
    for await (const row of gateway.stream(connection, {
      table,
      filters: [{ column: 'id', operator: 'gte', value: { kind: 'value', type: 'bigint', value: '10' } }],
      batchSize: 2,
    })) {
      rows.push(row)
    }

    expect(rows).toEqual([
      { id: { kind: 'value', type: 'bigint', value: '9007199254740993' }, note: { kind: 'value', type: 'string', value: 'first' } },
      { id: { kind: 'value', type: 'bigint', value: '9007199254740994' }, note: { kind: 'null' } },
    ])
    expect(statements).toEqual([
      { sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' },
      { sql: 'COMMIT' },
    ])
    expect(query.mock.calls[1]?.[0]).toEqual({ marker: 'cursor' })
    expect(createCursor).toHaveBeenCalledWith(
      'SELECT "id", "note" FROM "public"."orders" WHERE "id" >= $1',
      [10n],
    )
    expect(cursor.read).toHaveBeenCalledTimes(2)
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('closes the cursor, rolls back, and destroys the SSH channel after early return', async () => {
    const statements: string[] = []
    const socket = new PassThrough()
    const cursor = {
      read: vi.fn().mockResolvedValue([{ id: '1', note: 'first' }]),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const query = vi.fn((input: string | { marker: 'cursor' }) => {
      if (typeof input === 'string') {
        statements.push(input)
        return Promise.resolve({ rows: [] })
      }
      return cursor
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: query as unknown as PostgresTransferClient['query'],
      end: vi.fn().mockResolvedValue(undefined),
    }
    const gateway = new PostgresTransferDataGateway(
      () => client,
      () => ({ marker: 'cursor' }) as never,
      { open: vi.fn().mockResolvedValue(socket) },
    )

    for await (const row of gateway.stream({ ...connection, ssh: { enabled: true, host: 'ssh', port: 22, username: 'operator', password: 'ssh-secret' } }, {
      table,
      filters: [],
      batchSize: 1,
    })) {
      void row
      break
    }

    expect(cursor.close).toHaveBeenCalledOnce()
    expect(statements).toContain('ROLLBACK')
    expect(client.end).toHaveBeenCalledOnce()
    expect(socket.destroyed).toBe(true)
  })
})

describe('MysqlTransferDataGateway', () => {
  it('streams multiple tables inside one consistent read-only snapshot', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error) => void), callback?: (error?: Error) => void) => {
        statements.push(sql)
        queueMicrotask(() => (typeof values === 'function' ? values : callback)?.())
      }),
      end: vi.fn((callback: (error?: Error) => void) => callback()),
      destroy: vi.fn(),
    }
    const createRowStream = vi.fn()
      .mockReturnValueOnce(Readable.from([{ id: '1', note: 'first' }], { objectMode: true }))
      .mockReturnValueOnce(Readable.from([{ id: '2', note: 'second' }], { objectMode: true }))
    const gateway = new MysqlTransferDataGateway(async () => client, createRowStream)

    const rows = []
    for await (const row of gateway.streamMany({ ...connection, engine: 'mysql', port: 3306 }, [
      { id: 'orders-a', request: { table, filters: [], batchSize: 100 } },
      { id: 'orders-b', request: { table, filters: [], batchSize: 100 } },
    ])) rows.push(row)

    expect(rows.map((value) => [value.id, value.row.id])).toEqual([
      ['orders-a', { kind: 'value', type: 'bigint', value: '1' }],
      ['orders-b', { kind: 'value', type: 'bigint', value: '2' }],
    ])
    expect(statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'COMMIT',
    ])
    expect(createRowStream).toHaveBeenCalledTimes(2)
  })

  it('streams tagged rows from a consistent read-only snapshot with backpressure', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error) => void), callback?: (error?: Error) => void) => {
        const done = typeof values === 'function' ? values : callback
        statements.push({ sql, ...(Array.isArray(values) ? { values } : {}) })
        queueMicrotask(() => done?.())
      }),
      end: vi.fn((callback: (error?: Error) => void) => callback()),
      destroy: vi.fn(),
    }
    const createRowStream = vi.fn(() => Readable.from([
      { id: '9007199254740993', note: 'first' },
      { id: '9007199254740994', note: null },
    ], { objectMode: true }))
    const gateway = new MysqlTransferDataGateway(
      async () => client,
      createRowStream,
    )

    const rows = []
    for await (const row of gateway.stream({ ...connection, engine: 'mysql', port: 3306 }, {
      table,
      filters: [{ column: 'note', operator: 'eq', value: { kind: 'value', type: 'string', value: 'safe' } }],
      batchSize: 250,
    })) {
      rows.push(row)
    }

    expect(rows).toHaveLength(2)
    expect(statements.map((entry) => entry.sql)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'COMMIT',
    ])
    expect(createRowStream).toHaveBeenCalledWith(
      client,
      'SELECT `id`, `note` FROM `public`.`orders` WHERE `note` = ?',
      ['safe'],
      250,
    )
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('rolls back and returns a safe error when the driver stream fails', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error) => void), callback?: (error?: Error) => void) => {
        statements.push(sql)
        const done = typeof values === 'function' ? values : callback
        queueMicrotask(() => done?.())
      }),
      end: vi.fn((callback: (error?: Error) => void) => callback()),
      destroy: vi.fn(),
    }
    const stream = new Readable({
      objectMode: true,
      read() {
        this.destroy(new Error('driver-secret'))
      },
    })
    const gateway = new MysqlTransferDataGateway(async () => client, () => stream)

    const consume = async () => {
      for await (const row of gateway.stream({ ...connection, engine: 'mysql', port: 3306 }, {
        table,
        filters: [],
        batchSize: 100,
      })) {
        void row
      }
    }

    await expect(consume()).rejects.toEqual(new TransferDataError('TRANSFER_DATA_FAILED'))
    expect(statements).toContain('ROLLBACK')
    expect(client.end).toHaveBeenCalledOnce()
  })
})
