import { randomUUID } from 'node:crypto'

const DEFAULT_GLOBAL_LIMIT = 100
const DEFAULT_CONNECTION_LIMIT = 10
const DEFAULT_LEASE_DURATION_MS = 60_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 250

export type DatabaseOperationGateErrorCode =
  | 'DATABASE_OPERATION_BUSY'
  | 'INVALID_DATABASE_OPERATION'
  | 'LEASE_NOT_OWNED'
  | 'LEASE_EXPIRED'

export class DatabaseOperationGateError extends Error {
  constructor(
    readonly code: DatabaseOperationGateErrorCode,
    readonly retryable = false,
  ) {
    super(code)
    this.name = 'DatabaseOperationGateError'
  }
}

export interface DatabaseOperationLease {
  id: string
  ownerId: string
  connectionId: string
  acquiredAt: string
  expiresAt: string
}

export type DatabaseOperationLeaseMutationResult =
  | 'updated'
  | 'not-found'
  | 'not-owned'
  | 'expired'

export interface DatabaseOperationLeaseRepository {
  tryAcquire(
    lease: DatabaseOperationLease,
    now: string,
    globalLimit: number,
    connectionLimit: number,
  ): Promise<DatabaseOperationLease | undefined>
  heartbeat(
    leaseId: string,
    ownerId: string,
    now: string,
    expiresAt: string,
  ): Promise<DatabaseOperationLeaseMutationResult>
  release(leaseId: string, ownerId: string): Promise<DatabaseOperationLeaseMutationResult>
}

interface DatabaseOperationLeaseOptions {
  globalLimit?: number
  connectionLimit?: number
  leaseDurationMs?: number
}

export class DatabaseOperationLeaseService {
  private readonly globalLimit: number
  private readonly connectionLimit: number
  private readonly leaseDurationMs: number

  constructor(
    private readonly repository: DatabaseOperationLeaseRepository,
    options: DatabaseOperationLeaseOptions = {},
  ) {
    this.globalLimit = positiveInteger(options.globalLimit ?? DEFAULT_GLOBAL_LIMIT)
    this.connectionLimit = positiveInteger(options.connectionLimit ?? DEFAULT_CONNECTION_LIMIT)
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)
    if (this.connectionLimit > this.globalLimit) {
      throw new DatabaseOperationGateError('INVALID_DATABASE_OPERATION')
    }
  }

  async tryAcquire(
    ownerId: string,
    connectionId: string,
    now = new Date(),
  ): Promise<DatabaseOperationLease | undefined> {
    validateIdentifier(ownerId, 200)
    validateIdentifier(connectionId, 128)
    const acquiredAt = timestamp(now)
    return this.repository.tryAcquire({
      id: randomUUID(),
      ownerId,
      connectionId,
      acquiredAt,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    }, acquiredAt, this.globalLimit, this.connectionLimit)
  }

  async heartbeat(
    leaseId: string,
    ownerId: string,
    now = new Date(),
  ): Promise<void> {
    validateIdentifier(leaseId, 200)
    validateIdentifier(ownerId, 200)
    const result = await this.repository.heartbeat(
      leaseId,
      ownerId,
      timestamp(now),
      new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    )
    this.assertMutation(result)
  }

  async release(leaseId: string, ownerId: string): Promise<void> {
    validateIdentifier(leaseId, 200)
    validateIdentifier(ownerId, 200)
    this.assertMutation(await this.repository.release(leaseId, ownerId))
  }

  private assertMutation(result: DatabaseOperationLeaseMutationResult): void {
    if (result === 'updated') return
    if (result === 'expired') throw new DatabaseOperationGateError('LEASE_EXPIRED', true)
    throw new DatabaseOperationGateError('LEASE_NOT_OWNED', true)
  }
}

interface DatabaseOperationGateOptions {
  queueTimeoutMs?: number
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  now?: () => Date
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export class DatabaseOperationGate {
  private readonly queueTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly heartbeatIntervalMs: number
  private readonly now: () => Date
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(
    private readonly leases: DatabaseOperationLeaseService,
    private readonly ownerId: string,
    options: DatabaseOperationGateOptions = {},
  ) {
    validateIdentifier(ownerId, 200)
    this.queueTimeoutMs = positiveInteger(options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS)
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    )
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitFor
  }

  async enter(connectionId: string, externalSignal?: AbortSignal): Promise<DatabaseOperationPermit> {
    const startedAt = this.now().getTime()
    if (!Number.isFinite(startedAt)) throw new DatabaseOperationGateError('INVALID_DATABASE_OPERATION')
    let lease: DatabaseOperationLease | undefined
    while (!lease) {
      if (externalSignal?.aborted) throw externalSignal.reason
      lease = await this.leases.tryAcquire(this.ownerId, connectionId, this.now())
      if (lease) break
      const elapsed = this.now().getTime() - startedAt
      if (elapsed >= this.queueTimeoutMs) {
        throw new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true)
      }
      await this.wait(
        Math.min(this.pollIntervalMs, this.queueTimeoutMs - elapsed),
        externalSignal,
      )
    }

    const controller = new AbortController()
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal
    const heartbeat = setInterval(() => {
      void this.leases.heartbeat(lease.id, this.ownerId, this.now()).catch((error: unknown) => {
        controller.abort(error)
      })
    }, this.heartbeatIntervalMs)
    heartbeat.unref()

    let released = false
    return {
      signal,
      release: async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await this.leases.release(lease.id, this.ownerId)
      },
    }
  }

  async run<T>(
    connectionId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const permit = await this.enter(connectionId, externalSignal)
    let completion: { result: T } | { error: unknown }
    try {
      const result = await operation(permit.signal)
      if (permit.signal.aborted) throw permit.signal.reason
      completion = { result }
    } catch (error) {
      completion = { error }
    }
    let releaseError: unknown
    try {
      await permit.release()
    } catch (error) {
      releaseError = error
    }
    if ('error' in completion) throw completion.error
    if (releaseError !== undefined) throw releaseError
    return completion.result
  }
}

export interface DatabaseOperationPermit {
  signal: AbortSignal
  release(): Promise<void>
}

export class MemoryDatabaseOperationLeaseRepository implements DatabaseOperationLeaseRepository {
  private readonly leases = new Map<string, DatabaseOperationLease>()

  async tryAcquire(
    lease: DatabaseOperationLease,
    now: string,
    globalLimit: number,
    connectionLimit: number,
  ): Promise<DatabaseOperationLease | undefined> {
    this.deleteExpired(now)
    const active = [...this.leases.values()]
    if (active.length >= globalLimit) return undefined
    if (active.filter((candidate) => candidate.connectionId === lease.connectionId).length >= connectionLimit) {
      return undefined
    }
    this.leases.set(lease.id, structuredClone(lease))
    return structuredClone(lease)
  }

  async heartbeat(
    leaseId: string,
    ownerId: string,
    now: string,
    expiresAt: string,
  ): Promise<DatabaseOperationLeaseMutationResult> {
    const lease = this.leases.get(leaseId)
    if (!lease) return 'not-found'
    if (lease.ownerId !== ownerId) return 'not-owned'
    if (lease.expiresAt <= now) {
      this.leases.delete(leaseId)
      return 'expired'
    }
    lease.expiresAt = expiresAt
    return 'updated'
  }

  async release(
    leaseId: string,
    ownerId: string,
  ): Promise<DatabaseOperationLeaseMutationResult> {
    const lease = this.leases.get(leaseId)
    if (!lease) return 'not-found'
    if (lease.ownerId !== ownerId) return 'not-owned'
    this.leases.delete(leaseId)
    return 'updated'
  }

  list(): DatabaseOperationLease[] {
    return [...this.leases.values()].map((lease) => structuredClone(lease))
  }

  private deleteExpired(now: string): void {
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id)
    }
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DatabaseOperationGateError('INVALID_DATABASE_OPERATION')
  }
  return value
}

function validateIdentifier(value: string, maximumLength: number): void {
  if (!value.trim() || value.length > maximumLength || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })) {
    throw new DatabaseOperationGateError('INVALID_DATABASE_OPERATION')
  }
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new DatabaseOperationGateError('INVALID_DATABASE_OPERATION')
  return value.toISOString()
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
