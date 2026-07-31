import { describe, expect, it } from 'vitest'

import type { StoredTransferJob } from '../transfers/transfer-job.js'
import { TransferWorkerLeaseService } from '../transfers/transfer-worker-lease.js'
import { KyselyTransferJobRepository } from './kysely-transfer-job-repository.js'
import { KyselyTransferWorkerLeaseRepository } from './kysely-transfer-worker-lease-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

function job(id: string): StoredTransferJob {
  return {
    id,
    ownerId: 'user-1',
    connectionId: 'connection-1',
    direction: 'export',
    format: 'json',
    includeData: true,
    status: 'previewed',
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

describe('KyselyTransferWorkerLeaseRepository', () => {
  it('並行claim只有一位worker取得PG權威語意的租約', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const jobs = new KyselyTransferJobRepository(database)
    await jobs.createWithinLimits(job('11111111-1111-4111-8111-111111111111'), 2, 2)
    const leases = new KyselyTransferWorkerLeaseRepository(database)
    const service = new TransferWorkerLeaseService(leases)

    const results = await Promise.all([
      service.claim('worker-a', new Date('2026-08-01T00:00:10.000Z')),
      service.claim('worker-b', new Date('2026-08-01T00:00:10.000Z')),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.find(Boolean)).toMatchObject({ status: 'previewed', attemptCount: 1 })
    await database.destroy()
  })

  it('持久化租約並允許過期後由其他worker接手', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const jobs = new KyselyTransferJobRepository(database)
    await jobs.createWithinLimits(job('11111111-1111-4111-8111-111111111111'), 2, 2)
    const first = new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(database))
    await first.claim('worker-a', new Date('2026-08-01T00:00:00.000Z'))

    const persisted = await jobs.findById('11111111-1111-4111-8111-111111111111')
    expect(persisted).toMatchObject({
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-08-01T00:01:00.000Z',
      attemptCount: 1,
    })

    const second = new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(database))
    await expect(second.claim('worker-b', new Date('2026-08-01T00:01:01.000Z')))
      .resolves.toMatchObject({ leaseOwner: 'worker-b', attemptCount: 2 })
    await database.destroy()
  })

  it('工作取消後即使租約尚未到期也拒絕heartbeat', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const jobs = new KyselyTransferJobRepository(database)
    await jobs.createWithinLimits(job('11111111-1111-4111-8111-111111111111'), 2, 2)
    const service = new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(database))
    const claimed = await service.claim('worker-a', new Date('2026-08-01T00:00:00.000Z'))
    await jobs.replace(
      { ...claimed!, status: 'cancelled', updatedAt: '2026-08-01T00:00:01.000Z' },
      'previewed',
      claimed!.updatedAt,
    )

    await expect(service.heartbeat(
      claimed!.id,
      'worker-a',
      new Date('2026-08-01T00:00:20.000Z'),
    )).rejects.toEqual(expect.objectContaining({ code: 'LEASE_NOT_OWNED' }))
    await database.destroy()
  })
})
