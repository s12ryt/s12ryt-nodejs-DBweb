import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  DatabaseOperationGate,
  DatabaseOperationLeaseService,
  MemoryDatabaseOperationLeaseRepository,
} from './database-operation-gate.js'
import {
  gateAsyncIterableGateway,
  gateOperationGateway,
  gateSessionFactory,
} from './database-operation-adapters.js'

const connection = { id: 'connection-1' } as ResolvedConnection

describe('database operation adapters', () => {
  it('holds a lease for the complete promise operation and forwards the permit signal', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const gate = new DatabaseOperationGate(
      new DatabaseOperationLeaseService(repository, { globalLimit: 1, connectionLimit: 1 }),
      'instance-a',
    )
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    const execute = vi.fn(async (_connection: ResolvedConnection, request: { signal: AbortSignal }) => {
      expect(request.signal).toBeInstanceOf(AbortSignal)
      await blocked
      return 'done'
    })
    const gateway = gateOperationGateway({ execute }, gate)

    const result = gateway.execute(connection, { signal: new AbortController().signal })
    await vi.waitFor(() => expect(repository.list()).toHaveLength(1))
    finish()

    await expect(result).resolves.toBe('done')
    expect(repository.list()).toHaveLength(0)
  })

  it('holds a lease until an async iterable is exhausted or closed early', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const gate = new DatabaseOperationGate(
      new DatabaseOperationLeaseService(repository, { globalLimit: 1, connectionLimit: 1 }),
      'instance-a',
    )
    const stream = vi.fn(async function* (
      _connection: ResolvedConnection,
      request: { signal: AbortSignal },
    ) {
      expect(request.signal).toBeInstanceOf(AbortSignal)
      yield 1
      yield 2
    })
    const gateway = gateAsyncIterableGateway({ stream }, gate)

    for await (const value of gateway.stream(connection, { signal: new AbortController().signal })) {
      expect(value).toBe(1)
      expect(repository.list()).toHaveLength(1)
      break
    }

    expect(repository.list()).toHaveLength(0)
  })

  it('holds a session lease through close and releases it when open fails', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const gate = new DatabaseOperationGate(
      new DatabaseOperationLeaseService(repository, { globalLimit: 1, connectionLimit: 1 }),
      'instance-a',
    )
    const close = vi.fn(async () => undefined)
    const execute = vi.fn(async (_sql: string, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
    })
    const sessions = gateSessionFactory({
      open: vi.fn(async (openedConnection: ResolvedConnection) => {
        void openedConnection
        return { execute, close }
      }),
    }, gate)

    const session = await sessions.open(connection)
    expect(repository.list()).toHaveLength(1)
    await session.execute('SELECT 1', new AbortController().signal)
    await session.close()
    await session.close()
    expect(close).toHaveBeenCalledTimes(1)
    expect(repository.list()).toHaveLength(0)

    const failing = gateSessionFactory({
      open: vi.fn(async (openedConnection: ResolvedConnection) => {
        void openedConnection
        throw new Error('driver-secret')
      }),
    }, gate)
    await expect(failing.open(connection)).rejects.toThrow('driver-secret')
    expect(repository.list()).toHaveLength(0)
  })
})
