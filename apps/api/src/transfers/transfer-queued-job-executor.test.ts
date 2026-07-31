import { describe, expect, it, vi } from 'vitest'

import type { StoredTransferJob } from './transfer-job.js'
import { TransferQueuedJobExecutor, TransferQueuedJobExecutorError } from './transfer-queued-job-executor.js'

function job(): StoredTransferJob {
  return {
    id: '11111111-1111-4111-8111-111111111111', ownerId: 'user-1', connectionId: 'connection-1',
    direction: 'export', format: 'json', includeData: true, status: 'previewed',
    receivedBytes: 0, processedBytes: 0, processedRows: 0, processedTables: 0, errorCount: 0,
    executionRequestedAt: '2026-08-01T00:00:00.000Z', executionRequestedBy: 'user-1',
    leaseOwner: 'worker-a', leaseExpiresAt: '2026-08-01T00:01:00.000Z', attemptCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
  }
}

const enabledUser = {
  id: 'user-1', username: 'operator', normalizedUsername: 'operator', role: 'user' as const,
  enabled: true, passwordChangeRequired: false, passwordHash: 'hash', sessionRevision: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
}

describe('TransferQueuedJobExecutor', () => {
  it('以目前使用者狀態與重新簽發的preview token執行，並傳遞lease abort signal', async () => {
    const signal = new AbortController().signal
    const users = { findUserById: vi.fn(async () => enabledUser) }
    const plans = { issue: vi.fn(async () => 'worker-preview-token') }
    const handlers = { execute: vi.fn(async () => ({ bytes: 10 })) }
    const executor = new TransferQueuedJobExecutor(users, plans, handlers)

    await executor.execute(job(), signal)

    expect(users.findUserById).toHaveBeenCalledWith('user-1')
    expect(plans.issue).toHaveBeenCalledWith(job().id)
    expect(handlers.execute).toHaveBeenCalledWith(
      { id: 'user-1', role: 'user' }, job().id, 'worker-preview-token', signal,
    )
  })

  it('請求者被停用、刪除或需改密碼時不執行', async () => {
    const handlers = { execute: vi.fn() }
    const executor = new TransferQueuedJobExecutor(
      { findUserById: vi.fn(async () => ({ ...enabledUser, enabled: false })) },
      { issue: vi.fn(async () => 'token') },
      handlers,
    )

    await expect(executor.execute(job(), new AbortController().signal))
      .rejects.toEqual(new TransferQueuedJobExecutorError('EXECUTION_REQUESTER_UNAVAILABLE'))
    expect(handlers.execute).not.toHaveBeenCalled()
  })
})
