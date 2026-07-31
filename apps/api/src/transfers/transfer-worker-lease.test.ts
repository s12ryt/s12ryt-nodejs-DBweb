import { describe, expect, it } from 'vitest'

import type { StoredTransferJob } from './transfer-job.js'
import {
  MemoryTransferWorkerLeaseRepository,
  TransferWorkerLeaseError,
  TransferWorkerLeaseService,
} from './transfer-worker-lease.js'

function job(id: string, status: StoredTransferJob['status'] = 'previewed'): StoredTransferJob {
  return {
    id,
    ownerId: 'user-1',
    connectionId: 'connection-1',
    direction: 'export',
    format: 'json',
    includeData: true,
    status,
    receivedBytes: 0,
    processedBytes: 0,
    processedRows: 0,
    processedTables: 0,
    errorCount: 0,
    executionRequestedAt: '2026-08-01T00:00:00.000Z',
    executionRequestedBy: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
  }
}

describe('TransferWorkerLeaseService', () => {
  it('不會領取只有預覽、尚未明確要求執行的工作', async () => {
    const previewOnly = job('11111111-1111-4111-8111-111111111111')
    delete previewOnly.executionRequestedAt
    delete previewOnly.executionRequestedBy
    const repository = new MemoryTransferWorkerLeaseRepository([previewOnly])
    const service = new TransferWorkerLeaseService(repository)

    await expect(service.claim('worker-a', new Date('2026-08-01T00:00:01.000Z')))
      .resolves.toBeUndefined()
  })

  it('只claim已preview且到期可執行的工作，租約固定60秒', async () => {
    const repository = new MemoryTransferWorkerLeaseRepository([
      job('11111111-1111-4111-8111-111111111111', 'queued'),
      job('22222222-2222-4222-8222-222222222222'),
    ])
    const service = new TransferWorkerLeaseService(repository)

    const claimed = await service.claim('worker-a', new Date('2026-08-01T00:00:10.000Z'))

    expect(claimed).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      status: 'previewed',
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-08-01T00:01:10.000Z',
      attemptCount: 1,
    })
    await expect(service.claim('worker-b', new Date('2026-08-01T00:00:11.000Z')))
      .resolves.toBeUndefined()
  })

  it('20秒heartbeat續租，錯誤worker或過期租約不可renew與complete', async () => {
    const repository = new MemoryTransferWorkerLeaseRepository([
      job('11111111-1111-4111-8111-111111111111'),
    ])
    const service = new TransferWorkerLeaseService(repository)
    const started = new Date('2026-08-01T00:00:00.000Z')
    const claimed = await service.claim('worker-a', started)

    await expect(service.heartbeat(claimed!.id, 'worker-a', new Date('2026-08-01T00:00:20.000Z')))
      .resolves.toMatchObject({ leaseExpiresAt: '2026-08-01T00:01:20.000Z' })
    await expect(service.heartbeat(claimed!.id, 'worker-b', new Date('2026-08-01T00:00:21.000Z')))
      .rejects.toEqual(new TransferWorkerLeaseError('LEASE_NOT_OWNED'))
    await expect(service.complete(claimed!.id, 'worker-a', new Date('2026-08-01T00:01:21.000Z')))
      .rejects.toEqual(new TransferWorkerLeaseError('LEASE_EXPIRED'))
  })

  it('租約過期後由其他worker接手且attempt遞增', async () => {
    const repository = new MemoryTransferWorkerLeaseRepository([
      job('11111111-1111-4111-8111-111111111111'),
    ])
    const service = new TransferWorkerLeaseService(repository)
    await service.claim('worker-a', new Date('2026-08-01T00:00:00.000Z'))

    const reclaimed = await service.claim('worker-b', new Date('2026-08-01T00:01:01.000Z'))

    expect(reclaimed).toMatchObject({
      leaseOwner: 'worker-b',
      leaseExpiresAt: '2026-08-01T00:02:01.000Z',
      attemptCount: 2,
    })
  })

  it('工作取消後即使原租約尚未到期也不可heartbeat續租', async () => {
    const cancelled = job('11111111-1111-4111-8111-111111111111', 'cancelled')
    cancelled.leaseOwner = 'worker-a'
    cancelled.leaseExpiresAt = '2026-08-01T00:01:00.000Z'
    const service = new TransferWorkerLeaseService(
      new MemoryTransferWorkerLeaseRepository([cancelled]),
    )

    await expect(service.heartbeat(
      cancelled.id,
      'worker-a',
      new Date('2026-08-01T00:00:20.000Z'),
    )).rejects.toEqual(new TransferWorkerLeaseError('LEASE_NOT_OWNED'))
  })

  it('失敗以前30秒為基準指數退避，第五次失敗轉terminal failed', async () => {
    const repository = new MemoryTransferWorkerLeaseRepository([
      job('11111111-1111-4111-8111-111111111111'),
    ])
    const service = new TransferWorkerLeaseService(repository)
    let now = new Date('2026-08-01T00:00:00.000Z')

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await service.claim('worker-a', now)
      expect(claimed?.attemptCount).toBe(attempt)
      const failed = await service.fail(claimed!.id, 'worker-a', now)
      if (attempt < 5) {
        const delay = 30_000 * (2 ** (attempt - 1))
        expect(failed).toMatchObject({
          status: 'previewed',
          nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
        })
        await expect(service.claim('worker-b', new Date(now.getTime() + delay - 1)))
          .resolves.toBeUndefined()
        now = new Date(now.getTime() + delay)
      } else {
        expect(failed.status).toBe('failed')
        expect(failed).not.toHaveProperty('nextAttemptAt')
        await expect(service.claim('worker-b', new Date(now.getTime() + 86_400_000)))
          .resolves.toBeUndefined()
      }
    }
  })
})
