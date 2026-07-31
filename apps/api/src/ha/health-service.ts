export type HealthComponentStatus = 'up' | 'down' | 'degraded' | 'disabled'

export interface HealthSnapshot {
  ready: boolean
  degraded: boolean
  components: {
    metadata: HealthComponentStatus
    objectStorage: HealthComponentStatus
    redis: HealthComponentStatus
  }
}

export interface HealthService {
  check(): Promise<HealthSnapshot>
}
