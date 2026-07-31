import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StoredTransferJob } from './transfer-job.js'
import { TransferJobWorker, TransferJobWorkerScheduler } from './transfer-job-worker.js'

function job(): StoredTransferJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: 'user-1',
    connectionId: 'connection-1',
    direction: 'export',
    format: 'json',
    includeData: true,
    status: 'running',
    receivedBytes: 0,
    processedBytes: 0,
    processedRows: 0,
    processedTables: 0,
    errorCount: 0,
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-08-01T00:01:00.000Z',
    attemptCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TransferJobWorker', () => {
  it('執行期間每20秒heartbeat，成功後完成權威租約', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const execute = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const lease = {
      claim: vi.fn(async () => job()),
      heartbeat: vi.fn(async () => job()),
      complete: vi.fn(async () => ({ ...job(), status: 'succeeded' as const })),
      fail: vi.fn(async () => ({ ...job(), status: 'previewed' as const })),
    }
    const worker = new TransferJobWorker('worker-a', lease, { execute })

    const running = worker.runOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lease.heartbeat).toHaveBeenCalledTimes(1)
    expect(lease.heartbeat).toHaveBeenCalledWith(job().id, 'worker-a', expect.any(Date))
    finish()
    await running

    expect(lease.complete).toHaveBeenCalledWith(job().id, 'worker-a', expect.any(Date))
    expect(lease.fail).not.toHaveBeenCalled()
  })

  it('執行失敗交由租約服務排程重試且不讓worker loop崩潰', async () => {
    const lease = {
      claim: vi.fn(async () => job()),
      heartbeat: vi.fn(async () => job()),
      complete: vi.fn(async () => ({ ...job(), status: 'succeeded' as const })),
      fail: vi.fn(async () => ({ ...job(), status: 'previewed' as const })),
    }
    const worker = new TransferJobWorker('worker-a', lease, {
      execute: vi.fn(async () => { throw new Error('driver-secret') }),
    })

    await expect(worker.runOnce()).resolves.toBe(true)
    expect(lease.fail).toHaveBeenCalledWith(job().id, 'worker-a', expect.any(Date))
    expect(lease.complete).not.toHaveBeenCalled()
  })
})

describe('TransferJobWorkerScheduler', () => {
  it('立即輪詢、接受加速喚醒、防重疊，stop等待in-flight', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const runOnce = vi.fn(() => new Promise<boolean>((resolve) => { finish = () => resolve(true) }))
    const scheduler = new TransferJobWorkerScheduler({ runOnce }, { pollIntervalMs: 30_000 })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runOnce).toHaveBeenCalledTimes(1)
    scheduler.wake()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runOnce).toHaveBeenCalledTimes(1)

    const stopping = scheduler.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finish()
    await stopping
    expect(stopped).toBe(true)
  })
})
