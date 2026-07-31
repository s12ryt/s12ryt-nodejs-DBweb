export interface RedisFallbackCircuitOptions {
  failureThreshold?: number
  operationTimeoutMs?: number
  recoveryCooldownMs?: number
  recoverySuccessThreshold?: number
  now?: () => number
}

export interface RedisFallbackCircuitStatus {
  state: 'healthy' | 'degraded'
  consecutiveFailures: number
  recoverySuccesses: number
}

export class RedisFallbackCircuit {
  private readonly failureThreshold: number
  private readonly operationTimeoutMs: number
  private readonly recoveryCooldownMs: number
  private readonly recoverySuccessThreshold: number
  private readonly now: () => number
  private consecutiveFailures = 0
  private recoverySuccesses = 0
  private degradedAt: number | undefined
  private probeActive = false

  constructor(options: RedisFallbackCircuitOptions = {}) {
    this.failureThreshold = positiveInteger(options.failureThreshold ?? 3, 'failureThreshold')
    this.operationTimeoutMs = positiveInteger(options.operationTimeoutMs ?? 2_000, 'operationTimeoutMs')
    this.recoveryCooldownMs = positiveInteger(options.recoveryCooldownMs ?? 30_000, 'recoveryCooldownMs')
    this.recoverySuccessThreshold = positiveInteger(options.recoverySuccessThreshold ?? 3, 'recoverySuccessThreshold')
    this.now = options.now ?? Date.now
  }

  status(): RedisFallbackCircuitStatus {
    return {
      state: this.degradedAt === undefined ? 'healthy' : 'degraded',
      consecutiveFailures: this.consecutiveFailures,
      recoverySuccesses: this.recoverySuccesses,
    }
  }

  async run<T>(accelerated: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degradedAt !== undefined) {
      const cooldownElapsed = this.now() - this.degradedAt >= this.recoveryCooldownMs
      if ((!cooldownElapsed && this.recoverySuccesses === 0) || this.probeActive) return fallback()
      return this.runRecoveryProbe(accelerated, fallback)
    }

    try {
      const result = await withTimeout(accelerated(), this.operationTimeoutMs)
      this.consecutiveFailures = 0
      return result
    } catch {
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= this.failureThreshold) this.degradedAt = this.now()
      return fallback()
    }
  }

  private async runRecoveryProbe<T>(accelerated: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    this.probeActive = true
    try {
      const result = await withTimeout(accelerated(), this.operationTimeoutMs)
      this.recoverySuccesses += 1
      if (this.recoverySuccesses >= this.recoverySuccessThreshold) {
        this.degradedAt = undefined
        this.consecutiveFailures = 0
        this.recoverySuccesses = 0
      }
      return result
    } catch {
      this.degradedAt = this.now()
      this.consecutiveFailures = this.failureThreshold
      this.recoverySuccesses = 0
      return fallback()
    } finally {
      this.probeActive = false
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name.toUpperCase()}`)
  return value
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('REDIS_OPERATION_TIMEOUT')), timeoutMs)
    timer.unref?.()
    operation.then(resolve, reject).finally(() => clearTimeout(timer)).catch(() => undefined)
  })
}
