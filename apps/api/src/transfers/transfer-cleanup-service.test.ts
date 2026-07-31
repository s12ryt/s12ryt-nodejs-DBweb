import { describe, expect, it, vi } from 'vitest'

import type { StoredTransferJob } from './transfer-job.js'
import {
  TransferCleanupService,
  TransferCleanupScheduler,
  type TransferCleanupRepository,
} from './transfer-cleanup-service.js'

function job(
  id: string,
  status: StoredTransferJob['status'],
  updatedAt: string,
  expiresAt = '2026-10-29T12:00:00.000Z',
): StoredTransferJob {
  return {
    id,
    ownerId: 'user-1',
    connectionId: 'connection-1',
    direction: 'import',
    format: 'json',
    includeData: true,
    status,
    receivedBytes: 0,
    processedBytes: 0,
    processedRows: 0,
    processedTables: 0,
    errorCount: 0,
    createdAt: updatedAt,
    updatedAt,
    expiresAt,
  }
}

describe('TransferCleanupService', () => {
  it('依terminal狀態保留期限清理所有artifact，90天後才刪job metadata', async () => {
    const jobs = [
      job('00000000-0000-4000-8000-000000000001', 'succeeded', '2026-07-30T10:59:59.000Z'),
      job('00000000-0000-4000-8000-000000000002', 'cancelled', '2026-07-30T12:00:01.000Z'),
      job('00000000-0000-4000-8000-000000000003', 'failed', '2026-07-23T11:59:59.000Z'),
      job('00000000-0000-4000-8000-000000000004', 'running', '2026-04-01T00:00:00.000Z'),
    ]
    const repository: TransferCleanupRepository = {
      listAll: vi.fn(async () => jobs),
      deleteExpired: vi.fn(async () => 2),
    }
    const source = { deleteJob: vi.fn(async (id: string) => { void id }) }
    const output = { deleteJob: vi.fn(async (id: string) => { void id }) }
    const audit = { deleteExpired: vi.fn(async () => 3) }
    const service = new TransferCleanupService(repository, [source, output], [audit])

    await expect(service.tick(new Date('2026-07-31T12:00:00.000Z'))).resolves.toEqual({
      cleanedJobs: 2,
      failedJobs: 0,
      deletedMetadata: 5,
    })
    for (const cleaner of [source, output]) {
      expect(cleaner.deleteJob.mock.calls.map(([id]) => id)).toEqual([
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000003',
      ])
    }
    expect(repository.deleteExpired).toHaveBeenCalledWith('2026-07-31T12:00:00.000Z')
    expect(audit.deleteExpired).toHaveBeenCalledWith('2026-07-31T12:00:00.000Z')
  })

  it('隔離單一artifact清理失敗並保留全部到期metadata供下次重試', async () => {
    const first = job('00000000-0000-4000-8000-000000000011', 'succeeded', '2026-07-29T00:00:00.000Z')
    const second = job('00000000-0000-4000-8000-000000000012', 'failed', '2026-07-20T00:00:00.000Z')
    const repository: TransferCleanupRepository = {
      listAll: vi.fn(async () => [first, second]),
      deleteExpired: vi.fn(async () => 0),
    }
    const cleaner = {
      deleteJob: vi.fn(async (id: string) => {
        if (id === first.id) throw new Error('storage unavailable')
      }),
    }
    const audit = { deleteExpired: vi.fn(async () => 1) }

    await expect(new TransferCleanupService(repository, [cleaner], [audit]).tick(
      new Date('2026-07-31T12:00:00.000Z'),
    )).resolves.toEqual({ cleanedJobs: 1, failedJobs: 1, deletedMetadata: 0 })
    expect(cleaner.deleteJob).toHaveBeenCalledTimes(2)
    expect(repository.deleteExpired).not.toHaveBeenCalled()
    expect(audit.deleteExpired).not.toHaveBeenCalled()
  })
})

describe('TransferCleanupScheduler', () => {
  it('立即執行、避免重疊，停止時等待正在進行的清理', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const tick = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const scheduler = new TransferCleanupScheduler({ tick }, 60_000)

    scheduler.start()
    expect(tick).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tick).toHaveBeenCalledOnce()
    const stopped = scheduler.stop()
    let completed = false
    void stopped.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release?.()
    await stopped
    expect(completed).toBe(true)
    vi.useRealTimers()
  })
})
