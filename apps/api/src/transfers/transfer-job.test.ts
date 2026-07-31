import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import {
  MemoryTransferJobRepository,
  TransferJobError,
  TransferJobService,
  transitionTransferJob,
  type StoredTransferJob,
} from './transfer-job.js'

const admin: AuthUser = {
  id: 'admin-1',
  username: 'admin',
  role: 'admin',
  enabled: true,
  passwordChangeRequired: false,
}
const operator: AuthUser = {
  id: 'user-1',
  username: 'operator',
  role: 'user',
  enabled: true,
  passwordChangeRequired: false,
}
const otherUser: AuthUser = {
  ...operator,
  id: 'user-2',
  username: 'other',
}

function baseJob(status: StoredTransferJob['status'] = 'queued'): StoredTransferJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: operator.id,
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
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    expiresAt: '2026-10-29T00:00:00.000Z',
  }
}

describe('transfer job state', () => {
  it('只允許既定狀態轉移並維持進度單調', () => {
    const previewed = transitionTransferJob(baseJob(), 'previewed', {
      updatedAt: '2026-07-31T00:01:00.000Z',
      receivedBytes: 100,
    })
    const running = transitionTransferJob(previewed, 'running', {
      updatedAt: '2026-07-31T00:02:00.000Z',
    })
    const failed = transitionTransferJob(running, 'failed', {
      updatedAt: '2026-07-31T00:03:00.000Z',
      processedBytes: 80,
      processedRows: 8,
      errorCount: 1,
    })
    const resumed = transitionTransferJob(failed, 'queued', {
      updatedAt: '2026-07-31T00:04:00.000Z',
    })

    expect(resumed.status).toBe('queued')
    expect(resumed.processedRows).toBe(8)
    expect(() => transitionTransferJob(baseJob('succeeded'), 'running', {
      updatedAt: '2026-07-31T00:05:00.000Z',
    })).toThrowError(new TransferJobError('INVALID_JOB_TRANSITION'))
    expect(() => transitionTransferJob(failed, 'queued', {
      updatedAt: '2026-07-31T00:04:00.000Z',
      processedRows: 7,
    })).toThrowError(new TransferJobError('INVALID_JOB_PROGRESS'))
  })
})

describe('TransferJobService', () => {
  function setup() {
    const repository = new MemoryTransferJobRepository()
    const service = new TransferJobService(
      repository,
      async () => true,
      () => new Date('2026-07-31T00:00:00.000Z'),
    )
    return { repository, service }
  }

  it('授權後建立job，並以原子配額限制每位使用者及每個connection最多兩個active jobs', async () => {
    const { service } = setup()

    const results = await Promise.allSettled([
      service.create(operator, { connectionId: 'connection-1', direction: 'import', format: 'csv' }),
      service.create(operator, { connectionId: 'connection-1', direction: 'export', format: 'json' }),
      service.create(operator, { connectionId: 'connection-1', direction: 'export', format: 'sql' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'ACTIVE_JOB_LIMIT_REACHED' } })
    expect(await service.list(operator)).toHaveLength(2)

    await expect(service.create(otherUser, {
      connectionId: 'connection-1',
      direction: 'import',
      format: 'json',
    })).rejects.toMatchObject({ code: 'ACTIVE_JOB_LIMIT_REACHED' })
  })

  it('未授權時不建立job；建立者只能看自己的job，管理員可看全部', async () => {
    const repository = new MemoryTransferJobRepository()
    const denied = new TransferJobService(repository, async () => false)
    await expect(denied.create(operator, {
      connectionId: 'connection-1',
      direction: 'export',
      format: 'csv',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await repository.listAll()).toEqual([])

    const service = new TransferJobService(repository, async () => true)
    const own = await service.create(operator, {
      connectionId: 'connection-1',
      direction: 'export',
      format: 'csv',
    })
    await service.create(otherUser, {
      connectionId: 'connection-2',
      direction: 'import',
      format: 'json',
    })

    expect(await service.list(operator)).toEqual([own])
    expect(await service.list(admin)).toHaveLength(2)
    await expect(service.get(otherUser, own.id)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('建立者或管理員可取消active job，取消後釋放配額且terminal job不可重啟', async () => {
    const { service } = setup()
    const first = await service.create(operator, {
      connectionId: 'connection-1', direction: 'import', format: 'csv',
    })
    await service.create(operator, {
      connectionId: 'connection-1', direction: 'import', format: 'json',
    })

    const cancelled = await service.cancel(operator, first.id)
    expect(cancelled.status).toBe('cancelled')
    await expect(service.resume(operator, first.id)).rejects.toMatchObject({
      code: 'INVALID_JOB_TRANSITION',
    })
    await expect(service.create(operator, {
      connectionId: 'connection-1', direction: 'export', format: 'sql',
    })).resolves.toMatchObject({ status: 'queued' })
  })

  it('持久化SQL匯出是否含資料，並拒絕CSV或JSON宣告不含資料', async () => {
    const { service } = setup()
    await expect(service.create(operator, {
      connectionId: 'connection-1', direction: 'export', format: 'sql', includeData: false,
    })).resolves.toMatchObject({ includeData: false })
    await expect(service.create(operator, {
      connectionId: 'connection-2', direction: 'export', format: 'csv', includeData: false,
    })).rejects.toMatchObject({ code: 'INVALID_JOB' })
  })

  it('建立與取消job時記錄不含資料內容的安全稽核事件', async () => {
    const repository = new MemoryTransferJobRepository()
    const record = vi.fn(async () => undefined)
    const service = new TransferJobService(
      repository,
      async () => true,
      () => new Date('2026-07-31T00:00:00.000Z'),
      { record },
    )

    const job = await service.create(operator, {
      connectionId: 'connection-1', direction: 'export', format: 'sql', includeData: false,
    })
    await service.cancel(operator, job.id)

    expect(record).toHaveBeenNthCalledWith(1, {
      actorId: operator.id,
      jobId: job.id,
      connectionId: 'connection-1',
      direction: 'export',
      format: 'sql',
      action: 'job-create',
      status: 'success',
      details: { includeData: false },
    })
    expect(record).toHaveBeenNthCalledWith(2, {
      actorId: operator.id,
      jobId: job.id,
      connectionId: 'connection-1',
      direction: 'export',
      format: 'sql',
      action: 'job-cancel',
      status: 'success',
    })
  })
})
