import { describe, expect, it, vi } from 'vitest'

import {
  DatabaseOperationGate,
  DatabaseOperationGateError,
  DatabaseOperationLeaseService,
  MemoryDatabaseOperationLeaseRepository,
} from './database-operation-gate.js'

describe('DatabaseOperationLeaseService', () => {
  it('在所有實例間同時限制全域與每connection租約', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const service = new DatabaseOperationLeaseService(repository, {
      globalLimit: 2,
      connectionLimit: 1,
    })
    const now = new Date('2026-08-01T00:00:00.000Z')

    const first = await service.tryAcquire('instance-a', 'connection-a', now)
    expect(first).toBeDefined()
    await expect(service.tryAcquire('instance-b', 'connection-a', now)).resolves.toBeUndefined()

    const second = await service.tryAcquire('instance-b', 'connection-b', now)
    expect(second).toBeDefined()
    await expect(service.tryAcquire('instance-c', 'connection-c', now)).resolves.toBeUndefined()

    await service.release(first!.id, 'instance-a')
    await expect(service.tryAcquire('instance-c', 'connection-c', now)).resolves.toBeDefined()
  })

  it('回收逾時租約並拒絕非持有者續租或釋放', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const service = new DatabaseOperationLeaseService(repository, {
      globalLimit: 1,
      connectionLimit: 1,
      leaseDurationMs: 60_000,
    })
    const started = new Date('2026-08-01T00:00:00.000Z')
    const lease = await service.tryAcquire('instance-a', 'connection-a', started)

    await expect(service.heartbeat(lease!.id, 'instance-b', started))
      .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' })
    await expect(service.release(lease!.id, 'instance-b'))
      .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' })

    const afterExpiry = new Date('2026-08-01T00:01:00.001Z')
    await expect(service.tryAcquire('instance-b', 'connection-b', afterExpiry))
      .resolves.toBeDefined()
  })
})

describe('DatabaseOperationGate', () => {
  it('等待容量後執行，並在操作失敗時仍釋放租約', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const service = new DatabaseOperationLeaseService(repository, {
      globalLimit: 1,
      connectionLimit: 1,
    })
    const blocker = await service.tryAcquire(
      'other-instance',
      'connection-a',
      new Date('2026-08-01T00:00:00.000Z'),
    )
    let now = new Date('2026-08-01T00:00:00.000Z')
    const wait = vi.fn(async () => {
      now = new Date(now.getTime() + 100)
      await service.release(blocker!.id, 'other-instance')
    })
    const gate = new DatabaseOperationGate(service, 'instance-a', {
      now: () => now,
      wait,
      pollIntervalMs: 100,
    })

    await expect(gate.run('connection-a', async () => {
      throw new Error('driver-secret')
    })).rejects.toThrow('driver-secret')
    expect(wait).toHaveBeenCalledTimes(1)
    expect(repository.list()).toEqual([])
  })

  it('排隊超過30秒時回可重試busy且不執行操作', async () => {
    const repository = new MemoryDatabaseOperationLeaseRepository()
    const service = new DatabaseOperationLeaseService(repository, {
      globalLimit: 1,
      connectionLimit: 1,
    })
    await service.tryAcquire(
      'other-instance',
      'connection-a',
      new Date('2026-08-01T00:00:00.000Z'),
    )
    let now = new Date('2026-08-01T00:00:00.000Z')
    const gate = new DatabaseOperationGate(service, 'instance-a', {
      now: () => now,
      wait: async (milliseconds: number) => {
        now = new Date(now.getTime() + milliseconds)
      },
      pollIntervalMs: 10_000,
      queueTimeoutMs: 30_000,
    })
    const operation = vi.fn()

    await expect(gate.run('connection-a', operation)).rejects.toEqual(
      new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true),
    )
    expect(operation).not.toHaveBeenCalled()
  })
})
