import type { HealthService, HealthSnapshot } from './health-service.js'

export interface DependencyHealthServiceOptions {
  metadata(): Promise<void>
  objectStorage(): Promise<void>
  redisState?: () => 'healthy' | 'degraded'
}

export class DependencyHealthService implements HealthService {
  constructor(private readonly options: DependencyHealthServiceOptions) {}

  async check(): Promise<HealthSnapshot> {
    const [metadata, objectStorage] = await Promise.all([
      probe(this.options.metadata),
      probe(this.options.objectStorage),
    ])
    const redisState = this.options.redisState?.()
    const redis = redisState === undefined
      ? 'disabled' as const
      : redisState === 'healthy' ? 'up' as const : 'degraded' as const
    return {
      ready: metadata === 'up' && objectStorage === 'up',
      degraded: redis === 'degraded',
      components: { metadata, objectStorage, redis },
    }
  }
}

async function probe(operation: () => Promise<void>): Promise<'up' | 'down'> {
  try {
    await operation()
    return 'up'
  } catch {
    return 'down'
  }
}
