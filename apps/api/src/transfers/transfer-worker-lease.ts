import type { StoredTransferJob } from './transfer-job.js'

const LEASE_DURATION_MS = 60_000
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 30_000

export type TransferWorkerLeaseErrorCode =
  | 'INVALID_WORKER'
  | 'JOB_NOT_FOUND'
  | 'LEASE_NOT_OWNED'
  | 'LEASE_EXPIRED'

export class TransferWorkerLeaseError extends Error {
  constructor(readonly code: TransferWorkerLeaseErrorCode) {
    super(code)
    this.name = 'TransferWorkerLeaseError'
  }
}

export type TransferWorkerLeaseMutationResult =
  | { result: 'updated'; job: StoredTransferJob }
  | { result: 'not-found' | 'not-owned' | 'expired' }

export interface TransferWorkerLeaseRepository {
  claim(workerId: string, now: string, leaseExpiresAt: string): Promise<StoredTransferJob | undefined>
  heartbeat(
    jobId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TransferWorkerLeaseMutationResult>
  complete(jobId: string, workerId: string, now: string): Promise<TransferWorkerLeaseMutationResult>
  fail(
    jobId: string,
    workerId: string,
    now: string,
    maximumAttempts: number,
    retryBaseMs: number,
  ): Promise<TransferWorkerLeaseMutationResult>
}

export class TransferWorkerLeaseService {
  constructor(private readonly repository: TransferWorkerLeaseRepository) {}

  async claim(workerId: string, now = new Date()): Promise<StoredTransferJob | undefined> {
    this.assertWorker(workerId)
    const timestamp = this.timestamp(now)
    return this.repository.claim(
      workerId,
      timestamp,
      new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    )
  }

  async heartbeat(jobId: string, workerId: string, now = new Date()): Promise<StoredTransferJob> {
    this.assertWorker(workerId)
    const result = await this.repository.heartbeat(
      jobId,
      workerId,
      this.timestamp(now),
      new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    )
    return this.unwrap(result)
  }

  async complete(jobId: string, workerId: string, now = new Date()): Promise<StoredTransferJob> {
    this.assertWorker(workerId)
    return this.unwrap(await this.repository.complete(jobId, workerId, this.timestamp(now)))
  }

  async fail(jobId: string, workerId: string, now = new Date()): Promise<StoredTransferJob> {
    this.assertWorker(workerId)
    return this.unwrap(await this.repository.fail(
      jobId,
      workerId,
      this.timestamp(now),
      MAX_ATTEMPTS,
      RETRY_BASE_MS,
    ))
  }

  private unwrap(result: TransferWorkerLeaseMutationResult): StoredTransferJob {
    if (result.result === 'updated') return result.job
    if (result.result === 'not-found') throw new TransferWorkerLeaseError('JOB_NOT_FOUND')
    if (result.result === 'not-owned') throw new TransferWorkerLeaseError('LEASE_NOT_OWNED')
    throw new TransferWorkerLeaseError('LEASE_EXPIRED')
  }

  private assertWorker(workerId: string): void {
    if (!workerId.trim() || workerId.length > 200) {
      throw new TransferWorkerLeaseError('INVALID_WORKER')
    }
  }

  private timestamp(now: Date): string {
    if (!Number.isFinite(now.getTime())) throw new TransferWorkerLeaseError('INVALID_WORKER')
    return now.toISOString()
  }
}

export class MemoryTransferWorkerLeaseRepository implements TransferWorkerLeaseRepository {
  private readonly jobs = new Map<string, StoredTransferJob>()

  constructor(jobs: StoredTransferJob[] = []) {
    for (const job of jobs) this.jobs.set(job.id, structuredClone(job))
  }

  async claim(workerId: string, now: string, leaseExpiresAt: string): Promise<StoredTransferJob | undefined> {
    const candidate = [...this.jobs.values()]
      .filter((job) => this.isClaimable(job, now))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    if (!candidate) return undefined
    const claimed: StoredTransferJob = {
      ...candidate,
      status: 'previewed',
      leaseOwner: workerId,
      leaseExpiresAt,
      attemptCount: (candidate.attemptCount ?? 0) + 1,
      updatedAt: this.nextUpdatedAt(candidate.updatedAt, now),
    }
    delete claimed.nextAttemptAt
    this.jobs.set(claimed.id, structuredClone(claimed))
    return structuredClone(claimed)
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TransferWorkerLeaseMutationResult> {
    const current = this.jobs.get(jobId)
    if (current && current.status !== 'previewed' && current.status !== 'running') {
      return { result: 'not-owned' }
    }
    return this.mutateOwned(jobId, workerId, now, (job) => ({
      ...job,
      leaseExpiresAt,
      updatedAt: this.nextUpdatedAt(job.updatedAt, now),
    }))
  }

  async complete(
    jobId: string,
    workerId: string,
    now: string,
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.mutateOwned(jobId, workerId, now, (job) => {
      const completed: StoredTransferJob = {
        ...job,
        status: 'succeeded',
        updatedAt: this.nextUpdatedAt(job.updatedAt, now),
      }
      delete completed.leaseOwner
      delete completed.leaseExpiresAt
      delete completed.nextAttemptAt
      delete completed.executionRequestedAt
      delete completed.executionRequestedBy
      return completed
    })
  }

  async fail(
    jobId: string,
    workerId: string,
    now: string,
    maximumAttempts: number,
    retryBaseMs: number,
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.mutateOwned(jobId, workerId, now, (job) => {
      const attempt = job.attemptCount ?? 0
      const terminal = attempt >= maximumAttempts
      const nextAttemptAt = terminal
        ? undefined
        : new Date(Date.parse(now) + retryBaseMs * (2 ** Math.max(0, attempt - 1))).toISOString()
      const failed: StoredTransferJob = {
        ...job,
        status: terminal ? 'failed' : 'previewed',
        errorCount: job.errorCount + 1,
        updatedAt: this.nextUpdatedAt(job.updatedAt, now),
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      }
      delete failed.leaseOwner
      delete failed.leaseExpiresAt
      if (nextAttemptAt === undefined) delete failed.nextAttemptAt
      return failed
    })
  }

  private mutateOwned(
    jobId: string,
    workerId: string,
    now: string,
    mutate: (job: StoredTransferJob) => StoredTransferJob,
  ): TransferWorkerLeaseMutationResult {
    const job = this.jobs.get(jobId)
    if (!job) return { result: 'not-found' }
    if (job.leaseOwner !== workerId) return { result: 'not-owned' }
    if (!job.leaseExpiresAt || job.leaseExpiresAt <= now) return { result: 'expired' }
    const updated = mutate(structuredClone(job))
    this.jobs.set(jobId, structuredClone(updated))
    return { result: 'updated', job: structuredClone(updated) }
  }

  private isClaimable(job: StoredTransferJob, now: string): boolean {
    if ((job.attemptCount ?? 0) >= MAX_ATTEMPTS) return false
    if (job.status === 'previewed') {
      return Boolean(
        job.executionRequestedAt
        && job.executionRequestedBy
        && (!job.leaseExpiresAt || job.leaseExpiresAt <= now)
        && (!job.nextAttemptAt || job.nextAttemptAt <= now),
      )
    }
    return job.status === 'running' && Boolean(job.leaseExpiresAt && job.leaseExpiresAt <= now)
  }

  private nextUpdatedAt(current: string, requested: string): string {
    return new Date(Math.max(Date.parse(requested), Date.parse(current) + 1)).toISOString()
  }
}
