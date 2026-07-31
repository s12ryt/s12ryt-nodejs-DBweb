import type { AuthUser } from '../auth/auth-types.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'

type TransferActor = Pick<AuthUser, 'id' | 'role'>

export interface TransferExecutionPlanValidator {
  validate(jobId: string, token: string): Promise<unknown>
}

export interface TransferExecutionWake {
  notify(): Promise<void>
}

export type TransferExecutionQueueErrorCode =
  | 'EXECUTION_ALREADY_REQUESTED'
  | 'INVALID_EXECUTION_REQUEST'

export class TransferExecutionQueueError extends Error {
  constructor(readonly code: TransferExecutionQueueErrorCode) {
    super(code)
    this.name = 'TransferExecutionQueueError'
  }
}

export class TransferExecutionQueue {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly plans: TransferExecutionPlanValidator,
    private readonly wake: TransferExecutionWake,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(actor: TransferActor, jobId: string, previewToken: string): Promise<StoredTransferJob> {
    const job = await this.jobs.get(actor, jobId)
    if (job.status !== 'previewed' || !previewToken.trim()) {
      throw new TransferExecutionQueueError('INVALID_EXECUTION_REQUEST')
    }
    if (job.executionRequestedAt || job.executionRequestedBy) {
      throw new TransferExecutionQueueError('EXECUTION_ALREADY_REQUESTED')
    }
    await this.plans.validate(jobId, previewToken)
    const requestedAt = this.now()
    if (!Number.isFinite(requestedAt.getTime())) {
      throw new TransferExecutionQueueError('INVALID_EXECUTION_REQUEST')
    }
    const requested = await this.jobs.update(actor, jobId, (current) => {
      if (
        current.status !== 'previewed'
        || current.executionRequestedAt
        || current.executionRequestedBy
      ) throw new TransferExecutionQueueError('EXECUTION_ALREADY_REQUESTED')
      return {
        ...current,
        executionRequestedAt: requestedAt.toISOString(),
        executionRequestedBy: actor.id,
      }
    })
    try {
      await this.wake.notify()
    } catch {
      // PostgreSQL polling remains authoritative when Redis wake delivery fails.
    }
    return requested
  }
}
