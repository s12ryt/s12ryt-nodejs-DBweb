import type {
  ConnectionProfile,
  DatabaseEngine,
  ResolvedConnection,
} from '../connections/connection-types.js'
import type { SqlGateway } from '../query/sql-query-service.js'

export type KeepAliveStatus = 'success' | 'failed' | 'timeout'

export interface KeepAliveEvent {
  connectionId: string
  status: KeepAliveStatus
  durationMs: number
  createdAt: string
}

export interface KeepAliveRecorder {
  record(event: KeepAliveEvent): Promise<void>
}

export interface KeepAliveConnectionSource {
  list(): Promise<ConnectionProfile[]>
  resolveConnection(id: string): Promise<ResolvedConnection>
}

interface SqlKeepAliveOptions {
  now?: () => number
  timeoutMs?: number
}

export class SqlKeepAliveService {
  private readonly dueAt = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(
    private readonly connections: KeepAliveConnectionSource,
    private readonly gateways: Record<DatabaseEngine, SqlGateway>,
    private readonly recorder: KeepAliveRecorder,
    options: SqlKeepAliveOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async tick(): Promise<void> {
    const now = this.now()
    const profiles = await this.connections.list()
    const enabledIds = new Set<string>()
    const dueProfiles: ConnectionProfile[] = []

    for (const profile of profiles) {
      if (!profile.keepAlive.enabled) continue
      enabledIds.add(profile.id)
      const dueAt = this.dueAt.get(profile.id)
      if (dueAt === undefined) {
        this.dueAt.set(profile.id, now + profile.keepAlive.intervalMs)
      } else if (now >= dueAt && !this.running.has(profile.id)) {
        this.dueAt.set(profile.id, now + profile.keepAlive.intervalMs)
        dueProfiles.push(profile)
      }
    }

    for (const id of this.dueAt.keys()) {
      if (!enabledIds.has(id)) this.dueAt.delete(id)
    }

    await Promise.all(dueProfiles.map(async (profile) => this.probe(profile)))
  }

  private async probe(profile: ConnectionProfile): Promise<void> {
    this.running.add(profile.id)
    const startedAt = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let status: KeepAliveStatus = 'success'

    try {
      const connection = await this.connections.resolveConnection(profile.id)
      await this.gateways[connection.engine].execute(connection, {
        sql: 'SELECT 1',
        timeoutMs: this.timeoutMs,
        maxRows: 1,
        signal: controller.signal,
      })
    } catch {
      status = controller.signal.aborted ? 'timeout' : 'failed'
    } finally {
      clearTimeout(timer)
      this.running.delete(profile.id)
    }

    await this.recorder.record({
      connectionId: profile.id,
      status,
      durationMs: Math.max(0, this.now() - startedAt),
      createdAt: new Date(this.now()).toISOString(),
    })
  }
}

export class MemoryKeepAliveRecorder implements KeepAliveRecorder {
  private readonly events: KeepAliveEvent[] = []

  async record(event: KeepAliveEvent): Promise<void> {
    this.events.push(structuredClone(event))
  }

  async list(): Promise<KeepAliveEvent[]> {
    return structuredClone(this.events)
  }
}

export class KeepAliveScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private currentTick: Promise<void> | undefined

  constructor(
    private readonly service: { tick(): Promise<void> },
    private readonly refreshIntervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.run()
    this.timer = setInterval(() => this.run(), this.refreshIntervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.currentTick
  }

  private run(): void {
    if (this.currentTick) return
    const tick = this.service.tick().catch(() => {
      // A metadata outage must not create an unhandled rejection or disable future ticks.
    })
    const trackedTick = tick.finally(() => {
      if (this.currentTick === trackedTick) this.currentTick = undefined
    })
    this.currentTick = trackedTick
  }
}
