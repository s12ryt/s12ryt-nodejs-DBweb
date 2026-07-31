import { describe, expect, it, vi } from 'vitest'

import { TransferExecutionQueue, TransferExecutionQueueError } from './transfer-execution-queue.js'
import { MemoryTransferJobRepository, TransferJobService, transitionTransferJob } from './transfer-job.js'

const actor = { id: 'user-1', role: 'user' as const }

async function setup() {
  const jobs = new TransferJobService(
    new MemoryTransferJobRepository(),
    async () => true,
    () => new Date('2026-08-01T00:00:00.000Z'),
  )
  const created = await jobs.create(actor, {
    connectionId: 'connection-1', direction: 'export', format: 'json',
  })
  await jobs.update(actor, created.id, (job) => transitionTransferJob(job, 'previewed', {
    updatedAt: '2026-08-01T00:00:01.000Z',
  }))
  const plans = { validate: vi.fn(async () => ({})) }
  const wake = { notify: vi.fn(async () => undefined) }
  const queue = new TransferExecutionQueue(
    jobs,
    plans,
    wake,
    () => new Date('2026-08-01T00:00:02.000Z'),
  )
  return { created, jobs, plans, queue, wake }
}

describe('TransferExecutionQueue', () => {
  it('先驗preview token，再以PG job狀態記錄明確執行請求並喚醒worker', async () => {
    const environment = await setup()

    const requested = await environment.queue.request(actor, environment.created.id, 'signed-preview-token')

    expect(environment.plans.validate).toHaveBeenCalledWith(environment.created.id, 'signed-preview-token')
    expect(requested).toMatchObject({
      status: 'previewed',
      executionRequestedAt: '2026-08-01T00:00:02.000Z',
      executionRequestedBy: actor.id,
    })
    expect(environment.wake.notify).toHaveBeenCalledOnce()
  })

  it('Redis喚醒失敗不回滾已提交的PG執行請求', async () => {
    const environment = await setup()
    environment.wake.notify.mockRejectedValueOnce(new Error('redis-secret'))

    await expect(environment.queue.request(actor, environment.created.id, 'signed-preview-token'))
      .resolves.toMatchObject({ executionRequestedBy: actor.id })
    await expect(environment.jobs.get(actor, environment.created.id))
      .resolves.toMatchObject({ executionRequestedBy: actor.id })
  })

  it('拒絕重複排入', async () => {
    const environment = await setup()
    await environment.queue.request(actor, environment.created.id, 'signed-preview-token')

    await expect(environment.queue.request(actor, environment.created.id, 'signed-preview-token'))
      .rejects.toEqual(new TransferExecutionQueueError('EXECUTION_ALREADY_REQUESTED'))
  })
})
