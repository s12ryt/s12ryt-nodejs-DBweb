import type { StoredTransferJob } from './transfer-job.js'

const SHORT_RETENTION_MS = 24 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface TransferCleanupRepository {
  listAll(): Promise<StoredTransferJob[]>
  deleteExpired(now: string): Promise<number>
}

export interface TransferArtifactCleaner {
  deleteJob(jobId: string): Promise<void>
}

export interface TransferRetentionCleaner {
  deleteExpired(now: string): Promise<number>
}

export interface TransferCleanupResult {
  cleanedJobs: number
  failedJobs: number
  deletedMetadata: number
}

export class TransferCleanupService {
  constructor(
    private readonly repository: TransferCleanupRepository,
    private readonly cleaners: readonly TransferArtifactCleaner[],
    private readonly retentionCleaners: readonly TransferRetentionCleaner[] = [],
  ) {}

  async tick(now = new Date()): Promise<TransferCleanupResult> {
    const jobs = await this.repository.listAll()
    let cleanedJobs = 0
    let failedJobs = 0
    for (const job of jobs) {
      if (!isArtifactExpired(job, now)) continue
      const results = await Promise.allSettled(
        this.cleaners.map(async (cleaner) => cleaner.deleteJob(job.id)),
      )
      if (results.some((result) => result.status === 'rejected')) failedJobs += 1
      else cleanedJobs += 1
    }
    const deletedMetadata = failedJobs === 0
      ? (await Promise.all([
          this.repository.deleteExpired(now.toISOString()),
          ...this.retentionCleaners.map(async (cleaner) => cleaner.deleteExpired(now.toISOString())),
        ])).reduce((total, deleted) => total + deleted, 0)
      : 0
    return { cleanedJobs, failedJobs, deletedMetadata }
  }
}

interface CleanupTick {
  tick(): Promise<unknown>
}

export class TransferCleanupScheduler {
  private timer: NodeJS.Timeout | undefined
  private currentTick: Promise<void> | undefined

  constructor(
    private readonly service: CleanupTick,
    private readonly intervalMs = 60 * 60 * 1000,
  ) {}

  start(): void {
    if (this.timer) return
    this.trigger()
    this.timer = setInterval(() => this.trigger(), this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.currentTick
  }

  private trigger(): void {
    if (this.currentTick) return
    const tracked = Promise.resolve(this.service.tick())
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (this.currentTick === tracked) this.currentTick = undefined
      })
    this.currentTick = tracked
  }
}

function isArtifactExpired(job: StoredTransferJob, now: Date): boolean {
  const updatedAt = Date.parse(job.updatedAt)
  if (!Number.isFinite(updatedAt)) return false
  if (job.status === 'failed') return updatedAt + FAILED_RETENTION_MS <= now.getTime()
  if (job.status === 'succeeded' || job.status === 'cancelled') {
    return updatedAt + SHORT_RETENTION_MS <= now.getTime()
  }
  return false
}
