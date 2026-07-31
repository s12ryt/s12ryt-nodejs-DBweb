import { describe, expect, it, vi } from 'vitest'

import { RedisFallbackCircuit } from './redis-fallback-circuit.js'
import {
  createRedisRuntimeServices,
  type RedisRuntimeClient,
} from './redis-runtime.js'

function client() {
  return {
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    destroy: vi.fn(),
    duplicate: vi.fn(),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    sAdd: vi.fn(async () => undefined),
    expire: vi.fn(async () => undefined),
    sMembers: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
  }
}

describe('createRedisRuntimeServices', () => {
  it('以duplicate專用連線訂閱transfer wake並安全釋放兩個client', async () => {
    const publisher = client()
    const subscriber = client()
    publisher.duplicate.mockReturnValue(subscriber)
    const factory = vi.fn(() => publisher as unknown as RedisRuntimeClient)
    const circuit = new RedisFallbackCircuit()
    const wake = vi.fn()

    const services = await createRedisRuntimeServices('redis://cache.internal:6379', circuit, factory)
    await services.transferWake.start(wake)
    await services.transferWake.notify()

    expect(factory).toHaveBeenCalledWith({ url: 'redis://cache.internal:6379' })
    expect(publisher.connect).toHaveBeenCalledOnce()
    expect(publisher.duplicate).toHaveBeenCalledOnce()
    expect(subscriber.connect).toHaveBeenCalledOnce()
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'dbweb:transfer:wake:v1',
      expect.any(Function),
    )
    expect(publisher.publish).toHaveBeenCalledWith('dbweb:transfer:wake:v1', 'wake')

    await services.close()
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('dbweb:transfer:wake:v1')
    expect(subscriber.destroy).toHaveBeenCalledOnce()
    expect(publisher.destroy).toHaveBeenCalledOnce()
  })
})
