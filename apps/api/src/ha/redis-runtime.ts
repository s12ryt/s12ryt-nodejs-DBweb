import { createClient } from 'redis'

import type { SessionCache } from '../auth/cached-auth-repository.js'
import { RedisFallbackCircuit } from './redis-fallback-circuit.js'
import { RedisSessionCache, type RedisSessionClient } from './redis-session-cache.js'
import {
  RedisTransferWake,
  type RedisWakePublisher,
  type RedisWakeSubscriber,
} from './redis-transfer-wake.js'

export interface RedisRuntimeClient
  extends Omit<RedisSessionClient, 'publish'>, RedisWakePublisher, RedisWakeSubscriber {
  readonly isOpen: boolean
  on(event: 'error', listener: (error: unknown) => void): unknown
  connect(): Promise<unknown>
  destroy(): void
  duplicate(): RedisRuntimeClient
}

export type RedisRuntimeClientFactory = (options: { url: string }) => RedisRuntimeClient

export interface RedisRuntimeServices {
  sessionCache: SessionCache
  transferWake: Pick<RedisTransferWake, 'close' | 'notify' | 'start'>
  close(): Promise<void>
}

export async function createRedisRuntimeServices(
  url: string,
  circuit: RedisFallbackCircuit = new RedisFallbackCircuit(),
  create: RedisRuntimeClientFactory = (options) => createClient(options) as RedisRuntimeClient,
): Promise<RedisRuntimeServices> {
  const publisher = create({ url })
  const subscriber = publisher.duplicate()
  publisher.on('error', () => undefined)
  subscriber.on('error', () => undefined)
  try {
    await publisher.connect()
    await subscriber.connect()
    const transferWake = new RedisTransferWake(publisher, subscriber, circuit)
    return {
      sessionCache: new RedisSessionCache(publisher),
      transferWake,
      close: async () => {
        await transferWake.close()
        if (subscriber.isOpen) subscriber.destroy()
        if (publisher.isOpen) publisher.destroy()
      },
    }
  } catch (error) {
    if (subscriber.isOpen) subscriber.destroy()
    if (publisher.isOpen) publisher.destroy()
    throw error
  }
}
