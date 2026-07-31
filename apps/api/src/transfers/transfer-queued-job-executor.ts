import type { StoredUser } from '../auth/auth-types.js'
import type { StoredTransferJob } from './transfer-job.js'

export interface TransferExecutionUserDirectory {
  findUserById(id: string): Promise<StoredUser | undefined>
}

export interface TransferExecutionTokenIssuer {
  issue(jobId: string): Promise<string>
}

export interface QueuedTransferExecutionHandler {
  execute(
    actor: { id: string; role: StoredUser['role'] },
    jobId: string,
    previewToken: string,
    signal: AbortSignal,
  ): Promise<unknown>
}

export class TransferQueuedJobExecutorError extends Error {
  constructor(readonly code: 'EXECUTION_REQUESTER_UNAVAILABLE' | 'INVALID_EXECUTION_REQUEST') {
    super(code)
    this.name = 'TransferQueuedJobExecutorError'
  }
}

export class TransferQueuedJobExecutor {
  constructor(
    private readonly users: TransferExecutionUserDirectory,
    private readonly plans: TransferExecutionTokenIssuer,
    private readonly handlers: QueuedTransferExecutionHandler,
  ) {}

  async execute(job: StoredTransferJob, signal: AbortSignal): Promise<void> {
    if (!job.executionRequestedBy || !job.executionRequestedAt) {
      throw new TransferQueuedJobExecutorError('INVALID_EXECUTION_REQUEST')
    }
    const user = await this.users.findUserById(job.executionRequestedBy)
    if (!user?.enabled || user.passwordChangeRequired) {
      throw new TransferQueuedJobExecutorError('EXECUTION_REQUESTER_UNAVAILABLE')
    }
    const token = await this.plans.issue(job.id)
    await this.handlers.execute({ id: user.id, role: user.role }, job.id, token, signal)
  }
}
