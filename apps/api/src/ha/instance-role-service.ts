import type { HealthService, HealthSnapshot } from './health-service.js'

export type InstanceRole = 'active' | 'standby'

export interface InstanceRoleLease {
  instanceId: string
  role: InstanceRole
  leaseExpiresAt: Date
}

export interface InstanceRoleRepository {
  heartbeat(
    instanceId: string,
    now: Date,
    leaseDurationMs: number,
    activeLimit: number,
  ): Promise<InstanceRoleLease>
  release(instanceId: string): Promise<void>
}

interface InstanceRoleCoordinatorOptions {
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  activeLimit?: number
  now?: () => Date
  onRoleChange?: (role: InstanceRole) => Promise<void>
}

export class InstanceRoleCoordinator {
  private readonly leaseDurationMs: number
  private readonly heartbeatIntervalMs: number
  private readonly activeLimit: number
  private readonly now: () => Date
  private readonly onRoleChange: ((role: InstanceRole) => Promise<void>) | undefined
  private role: InstanceRole = 'standby'
  private leaseExpiresAt: Date | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private currentTick: Promise<void> | undefined

  constructor(
    private readonly repository: InstanceRoleRepository,
    private readonly instanceId: string,
    options: InstanceRoleCoordinatorOptions = {},
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(instanceId)) {
      throw new Error('INVALID_INSTANCE_ID')
    }
    this.leaseDurationMs = options.leaseDurationMs ?? 20_000
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.activeLimit = options.activeLimit ?? 2
    this.now = options.now ?? (() => new Date())
    this.onRoleChange = options.onRoleChange
    if (
      !Number.isSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs <= 0
      || !Number.isSafeInteger(this.heartbeatIntervalMs)
      || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs >= this.leaseDurationMs
      || !Number.isSafeInteger(this.activeLimit)
      || this.activeLimit <= 0
    ) throw new Error('INVALID_INSTANCE_ROLE_OPTIONS')
  }

  status(): { instanceId: string; role: InstanceRole; leaseExpiresAt?: Date } {
    return {
      instanceId: this.instanceId,
      role: this.role,
      ...(this.leaseExpiresAt ? { leaseExpiresAt: new Date(this.leaseExpiresAt) } : {}),
    }
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.tick()
    this.timer = setInterval(() => this.trigger(), this.heartbeatIntervalMs)
    this.timer.unref?.()
  }

  async tick(): Promise<void> {
    const lease = await this.repository.heartbeat(
      this.instanceId,
      this.now(),
      this.leaseDurationMs,
      this.activeLimit,
    )
    this.leaseExpiresAt = new Date(lease.leaseExpiresAt)
    await this.changeRole(lease.role)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.currentTick
    await this.repository.release(this.instanceId)
    this.leaseExpiresAt = undefined
    await this.changeRole('standby')
  }

  private trigger(): void {
    if (this.currentTick) return
    const tracked = this.tick()
      .catch(() => undefined)
      .finally(() => {
        if (this.currentTick === tracked) this.currentTick = undefined
      })
    this.currentTick = tracked
  }

  private async changeRole(next: InstanceRole): Promise<void> {
    if (next === this.role) return
    await this.onRoleChange?.(next)
    this.role = next
  }
}

export class InstanceRoleHealthService implements HealthService {
  constructor(
    private readonly base: HealthService,
    private readonly getRole: () => InstanceRole,
  ) {}

  async check(): Promise<HealthSnapshot> {
    const snapshot = await this.base.check()
    const role = this.getRole()
    return {
      ...snapshot,
      ready: snapshot.ready && role === 'active',
      role,
    }
  }
}

export class MemoryInstanceRoleRepository implements InstanceRoleRepository {
  private readonly leases = new Map<string, InstanceRoleLease>()

  async heartbeat(
    instanceId: string,
    now: Date,
    leaseDurationMs: number,
    activeLimit: number,
  ): Promise<InstanceRoleLease> {
    const active = [...this.leases.values()].filter((lease) => (
      lease.instanceId !== instanceId
      && lease.role === 'active'
      && lease.leaseExpiresAt.getTime() > now.getTime()
    ))
    const existing = this.leases.get(instanceId)
    const role = existing?.role === 'active' && existing.leaseExpiresAt.getTime() > now.getTime()
      ? 'active'
      : active.length < activeLimit ? 'active' : 'standby'
    const lease = {
      instanceId,
      role,
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
    } satisfies InstanceRoleLease
    this.leases.set(instanceId, lease)
    return { ...lease, leaseExpiresAt: new Date(lease.leaseExpiresAt) }
  }

  async release(instanceId: string): Promise<void> {
    this.leases.delete(instanceId)
  }
}
