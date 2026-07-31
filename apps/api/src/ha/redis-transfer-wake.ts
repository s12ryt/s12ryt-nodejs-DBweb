import type { RedisFallbackCircuitStatus } from './redis-fallback-circuit.js'
import { RedisFallbackCircuit } from './redis-fallback-circuit.js'

const TRANSFER_WAKE_CHANNEL = 'dbweb:transfer:wake:v1'

export interface RedisWakePublisher {
  publish(channel: string, message: string): Promise<number>
}

export interface RedisWakeSubscriber {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>
  unsubscribe?(channel: string): Promise<unknown>
}

export class RedisTransferWake {
  private started = false

  constructor(
    private readonly publisher: RedisWakePublisher,
    private readonly subscriber: RedisWakeSubscriber,
    private readonly circuit: RedisFallbackCircuit,
  ) {}

  async notify(): Promise<void> {
    await this.circuit.run(
      async () => { await this.publisher.publish(TRANSFER_WAKE_CHANNEL, 'wake') },
      async () => undefined,
    )
  }

  async start(onWake: () => void): Promise<void> {
    if (this.started) return
    const subscribed = await this.circuit.run(
      async () => {
        await this.subscriber.subscribe(TRANSFER_WAKE_CHANNEL, () => onWake())
        return true
      },
      async () => false,
    )
    this.started = subscribed
  }

  status(): RedisFallbackCircuitStatus {
    return this.circuit.status()
  }

  async close(): Promise<void> {
    if (!this.started) return
    this.started = false
    try {
      await this.subscriber.unsubscribe?.(TRANSFER_WAKE_CHANNEL)
    } catch {
      // PostgreSQL polling remains authoritative when Redis is unavailable.
    }
  }
}
