import type { StoredTransferJob } from './transfer-job.js'

const HEARTBEAT_INTERVAL_MS = 20_000

export interface TransferJobLeaseController {
  claim(workerId: string, now?: Date): Promise<StoredTransferJob | undefined>
  heartbeat(jobId: string, workerId: string, now?: Date): Promise<StoredTransferJob>
  complete(jobId: string, workerId: string, now?: Date): Promise<StoredTransferJob>
  fail(jobId: string, workerId: string, now?: Date): Promise<StoredTransferJob>
}

export interface TransferJobExecutor {
  execute(job: StoredTransferJob, signal: AbortSignal): Promise<void>
}

export class TransferJobWorker {
  constructor(
    private readonly workerId: string,
    private readonly leases: TransferJobLeaseController,
    private readonly executor: TransferJobExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.leases.claim(this.workerId, this.now())
    if (!job) return false

    const abortController = new AbortController()
    let leaseLost = false
    let heartbeatTask: Promise<void> | undefined
    const heartbeat = (): void => {
      if (heartbeatTask || leaseLost) return
      heartbeatTask = this.leases.heartbeat(job.id, this.workerId, this.now())
        .then(() => undefined)
        .catch(() => {
          leaseLost = true
          abortController.abort(new Error('TRANSFER_WORKER_LEASE_LOST'))
        })
        .finally(() => { heartbeatTask = undefined })
    }
    const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)
    timer.unref?.()

    try {
      await this.executor.execute(job, abortController.signal)
      if (!leaseLost) await this.leases.complete(job.id, this.workerId, this.now())
    } catch {
      if (!leaseLost) {
        try {
          await this.leases.fail(job.id, this.workerId, this.now())
        } catch {
          // A lost or expired lease is already recoverable by another worker.
        }
      }
    } finally {
      clearInterval(timer)
      await heartbeatTask
    }
    return true
  }
}

export interface TransferJobWorkerRunner {
  runOnce(): Promise<boolean>
}

export interface TransferJobWorkerSchedulerOptions {
  pollIntervalMs?: number
}

export class TransferJobWorkerScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private currentTick: Promise<void> | undefined
  private pending = false
  private started = false

  constructor(
    private readonly worker: TransferJobWorkerRunner,
    private readonly options: TransferJobWorkerSchedulerOptions = {},
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    const interval = this.options.pollIntervalMs ?? 30_000
    this.timer = setInterval(() => this.wake(), interval)
    this.timer.unref?.()
    this.wake()
  }

  wake(): void {
    if (!this.started) return
    if (this.currentTick) {
      this.pending = true
      return
    }
    this.startTick()
  }

  async stop(): Promise<void> {
    this.started = false
    this.pending = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.currentTick
  }

  private startTick(): void {
    const tick = this.worker.runOnce()
      .catch(() => false)
      .then(() => undefined)
    const tracked = tick.finally(() => {
      if (this.currentTick === tracked) this.currentTick = undefined
      if (this.started && this.pending) {
        this.pending = false
        this.startTick()
      }
    })
    this.currentTick = tracked
  }
}
