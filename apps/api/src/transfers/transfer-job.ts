import { randomUUID } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { TransferAuditRecorder } from './transfer-audit.js'

const JOB_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const ACTIVE_JOB_LIMIT = 2
const ACTIVE_STATUSES = new Set<TransferJobStatus>(['queued', 'previewed', 'running'])

export type TransferJobStatus =
  | 'queued'
  | 'previewed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type TransferDirection = 'import' | 'export'
export type TransferFormat = 'csv' | 'json' | 'sql'

export interface StoredTransferJob {
  id: string
  ownerId: string
  connectionId: string
  direction: TransferDirection
  format: TransferFormat
  includeData: boolean
  status: TransferJobStatus
  receivedBytes: number
  processedBytes: number
  processedRows: number
  processedTables: number
  errorCount: number
  sourceBytes?: number
  sourceChecksum?: string
  uploadCompletedAt?: string
  executionRequestedAt?: string
  executionRequestedBy?: string
  leaseOwner?: string
  leaseExpiresAt?: string
  attemptCount?: number
  nextAttemptAt?: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface CreateTransferJobInput {
  connectionId: string
  direction: TransferDirection
  format: TransferFormat
  includeData?: boolean
}

export type TransferJobErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_JOB'
  | 'JOB_NOT_FOUND'
  | 'ACTIVE_JOB_LIMIT_REACHED'
  | 'INVALID_JOB_TRANSITION'
  | 'INVALID_JOB_PROGRESS'

export class TransferJobError extends Error {
  constructor(readonly code: TransferJobErrorCode) {
    super(code)
    this.name = 'TransferJobError'
  }
}

export type TransferJobAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  input: CreateTransferJobInput,
) => Promise<boolean>

export interface TransferJobRepository {
  createWithinLimits(
    job: StoredTransferJob,
    ownerLimit: number,
    connectionLimit: number,
  ): Promise<'created' | 'owner-limit' | 'connection-limit'>
  findById(id: string): Promise<StoredTransferJob | undefined>
  listByOwner(ownerId: string): Promise<StoredTransferJob[]>
  listAll(): Promise<StoredTransferJob[]>
  replace(
    job: StoredTransferJob,
    expectedStatus: TransferJobStatus,
    expectedUpdatedAt: string,
  ): Promise<boolean>
}

type ProgressField =
  | 'receivedBytes'
  | 'processedBytes'
  | 'processedRows'
  | 'processedTables'
  | 'errorCount'

export type TransferJobTransition = Pick<StoredTransferJob, 'updatedAt'> &
  Partial<Pick<StoredTransferJob, ProgressField>>

const TRANSITIONS: Readonly<Record<TransferJobStatus, ReadonlySet<TransferJobStatus>>> = {
  queued: new Set(['previewed', 'failed', 'cancelled']),
  previewed: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  failed: new Set(['queued']),
  succeeded: new Set(),
  cancelled: new Set(),
}

export function transitionTransferJob(
  job: StoredTransferJob,
  status: TransferJobStatus,
  patch: TransferJobTransition,
): StoredTransferJob {
  if (!TRANSITIONS[job.status].has(status)) {
    throw new TransferJobError('INVALID_JOB_TRANSITION')
  }
  const progressFields: ProgressField[] = [
    'receivedBytes',
    'processedBytes',
    'processedRows',
    'processedTables',
    'errorCount',
  ]
  for (const field of progressFields) {
    const next = patch[field]
    if (next !== undefined && (!Number.isSafeInteger(next) || next < job[field])) {
      throw new TransferJobError('INVALID_JOB_PROGRESS')
    }
  }
  return { ...job, ...patch, status }
}

export class TransferJobService {
  constructor(
    private readonly repository: TransferJobRepository,
    private readonly authorize: TransferJobAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async create(actor: Pick<AuthUser, 'id' | 'role'>, input: CreateTransferJobInput): Promise<StoredTransferJob> {
    this.validateInput(input)
    if (!await this.authorize(actor, input)) throw new TransferJobError('FORBIDDEN')
    const now = this.now()
    const job: StoredTransferJob = {
      id: randomUUID(),
      ownerId: actor.id,
      connectionId: input.connectionId,
      direction: input.direction,
      format: input.format,
      includeData: input.format === 'sql' ? input.includeData ?? true : true,
      status: 'queued',
      receivedBytes: 0,
      processedBytes: 0,
      processedRows: 0,
      processedTables: 0,
      errorCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + JOB_RETENTION_MS).toISOString(),
    }
    const result = await this.repository.createWithinLimits(
      job,
      ACTIVE_JOB_LIMIT,
      ACTIVE_JOB_LIMIT,
    )
    if (result !== 'created') throw new TransferJobError('ACTIVE_JOB_LIMIT_REACHED')
    await this.audit?.record({
      actorId: actor.id,
      jobId: job.id,
      connectionId: job.connectionId,
      direction: job.direction,
      format: job.format,
      action: 'job-create',
      status: 'success',
      details: { includeData: job.includeData },
    })
    return job
  }

  async get(actor: Pick<AuthUser, 'id' | 'role'>, id: string): Promise<StoredTransferJob> {
    const job = await this.repository.findById(id)
    if (!job || (actor.role !== 'admin' && job.ownerId !== actor.id)) {
      throw new TransferJobError('JOB_NOT_FOUND')
    }
    return job
  }

  async list(actor: Pick<AuthUser, 'id' | 'role'>): Promise<StoredTransferJob[]> {
    return actor.role === 'admin'
      ? this.repository.listAll()
      : this.repository.listByOwner(actor.id)
  }

  async cancel(actor: Pick<AuthUser, 'id' | 'role'>, id: string): Promise<StoredTransferJob> {
    const cancelled = await this.update(actor, id, (job) => transitionTransferJob(job, 'cancelled', {
      updatedAt: this.nextUpdatedAt(job.updatedAt),
    }))
    await this.audit?.record({
      actorId: actor.id,
      jobId: cancelled.id,
      connectionId: cancelled.connectionId,
      direction: cancelled.direction,
      format: cancelled.format,
      action: 'job-cancel',
      status: 'success',
    })
    return cancelled
  }

  async resume(actor: Pick<AuthUser, 'id' | 'role'>, id: string): Promise<StoredTransferJob> {
    return this.update(actor, id, (job) => transitionTransferJob(job, 'queued', {
      updatedAt: this.nextUpdatedAt(job.updatedAt),
    }))
  }

  async update(
    actor: Pick<AuthUser, 'id' | 'role'>,
    id: string,
    mutate: (job: StoredTransferJob) => StoredTransferJob,
  ): Promise<StoredTransferJob> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const job = await this.get(actor, id)
      const updated = mutate(structuredClone(job))
      this.validateProgress(job, updated)
      const next = {
        ...updated,
        updatedAt: this.nextUpdatedAt(job.updatedAt, updated.updatedAt),
      }
      if (await this.repository.replace(next, job.status, job.updatedAt)) return next
    }
    throw new TransferJobError('INVALID_JOB_TRANSITION')
  }

  private validateInput(input: CreateTransferJobInput): void {
    if (!input.connectionId.trim()) throw new TransferJobError('INVALID_JOB')
    if (!['import', 'export'].includes(input.direction) || !['csv', 'json', 'sql'].includes(input.format)) {
      throw new TransferJobError('INVALID_JOB')
    }
    if (input.format !== 'sql' && input.includeData === false) {
      throw new TransferJobError('INVALID_JOB')
    }
  }

  private validateProgress(current: StoredTransferJob, updated: StoredTransferJob): void {
    const fields = [
      'receivedBytes', 'processedBytes', 'processedRows', 'processedTables', 'errorCount',
    ] as const
    for (const field of fields) {
      if (!Number.isSafeInteger(updated[field]) || updated[field] < current[field]) {
        throw new TransferJobError('INVALID_JOB_PROGRESS')
      }
    }
  }

  private nextUpdatedAt(current: string, requested = this.now().toISOString()): string {
    const currentTime = Date.parse(current)
    const requestedTime = Date.parse(requested)
    if (!Number.isFinite(currentTime) || !Number.isFinite(requestedTime)) {
      throw new TransferJobError('INVALID_JOB_PROGRESS')
    }
    return new Date(Math.max(requestedTime, currentTime + 1)).toISOString()
  }
}

export class MemoryTransferJobRepository implements TransferJobRepository {
  private readonly jobs = new Map<string, StoredTransferJob>()

  async createWithinLimits(
    job: StoredTransferJob,
    ownerLimit: number,
    connectionLimit: number,
  ): Promise<'created' | 'owner-limit' | 'connection-limit'> {
    const active = [...this.jobs.values()].filter((candidate) => ACTIVE_STATUSES.has(candidate.status))
    if (active.filter((candidate) => candidate.ownerId === job.ownerId).length >= ownerLimit) {
      return 'owner-limit'
    }
    if (active.filter((candidate) => candidate.connectionId === job.connectionId).length >= connectionLimit) {
      return 'connection-limit'
    }
    this.jobs.set(job.id, structuredClone(job))
    return 'created'
  }

  async findById(id: string): Promise<StoredTransferJob | undefined> {
    const job = this.jobs.get(id)
    return job ? structuredClone(job) : undefined
  }

  async listByOwner(ownerId: string): Promise<StoredTransferJob[]> {
    return this.sorted([...this.jobs.values()].filter((job) => job.ownerId === ownerId))
  }

  async listAll(): Promise<StoredTransferJob[]> {
    return this.sorted([...this.jobs.values()])
  }

  async deleteExpired(now: string): Promise<number> {
    let deleted = 0
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) {
        this.jobs.delete(id)
        deleted += 1
      }
    }
    return deleted
  }

  async replace(
    job: StoredTransferJob,
    expectedStatus: TransferJobStatus,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    const current = this.jobs.get(job.id)
    if (
      !current
      || current.status !== expectedStatus
      || current.updatedAt !== expectedUpdatedAt
    ) return false
    this.jobs.set(job.id, structuredClone(job))
    return true
  }

  private sorted(jobs: StoredTransferJob[]): StoredTransferJob[] {
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => structuredClone(job))
  }
}
