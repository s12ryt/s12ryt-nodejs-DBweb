import { describe, expect, it, vi } from 'vitest'

import { RedisFallbackCircuit } from './redis-fallback-circuit.js'
import { RedisTransferWake } from './redis-transfer-wake.js'

describe('RedisTransferWake', () => {
  it('publish失敗時靜默降級，PostgreSQL輪詢仍可繼續', async () => {
    const publish = vi.fn(async () => { throw new Error('redis-secret') })
    const circuit = new RedisFallbackCircuit({ failureThreshold: 3 })
    const wake = new RedisTransferWake({ publish }, { subscribe: vi.fn() }, circuit)

    await expect(wake.notify()).resolves.toBeUndefined()
    await expect(wake.notify()).resolves.toBeUndefined()
    await expect(wake.notify()).resolves.toBeUndefined()

    expect(circuit.status()).toMatchObject({ state: 'degraded', consecutiveFailures: 3 })
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('只把固定channel訊息轉成喚醒，不信任payload', async () => {
    let listener: ((message: string) => void) | undefined
    const subscribe = vi.fn(async (_channel: string, callback: (message: string) => void) => {
      listener = callback
    })
    const onWake = vi.fn()
    const wake = new RedisTransferWake(
      { publish: vi.fn(async () => 1) },
      { subscribe, unsubscribe: vi.fn(async () => undefined) },
      new RedisFallbackCircuit(),
    )

    await wake.start(onWake)
    listener?.('{"jobId":"untrusted"}')

    expect(subscribe).toHaveBeenCalledWith('dbweb:transfer:wake:v1', expect.any(Function))
    expect(onWake).toHaveBeenCalledTimes(1)
    await wake.close()
  })

  it('subscriber不可達時不阻止啟動且不曝底層錯誤', async () => {
    const wake = new RedisTransferWake(
      { publish: vi.fn(async () => 1) },
      { subscribe: vi.fn(async () => { throw new Error('redis-password') }) },
      new RedisFallbackCircuit({ failureThreshold: 1 }),
    )

    await expect(wake.start(vi.fn())).resolves.toBeUndefined()
    expect(wake.status()).toMatchObject({ state: 'degraded' })
  })
})
