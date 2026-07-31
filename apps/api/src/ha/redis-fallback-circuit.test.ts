import { afterEach, describe, expect, it, vi } from 'vitest'
import { RedisFallbackCircuit } from './redis-fallback-circuit.js'

describe('RedisFallbackCircuit', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens after three Redis failures and serves PostgreSQL without retry storms', async () => {
    const redis = vi.fn().mockRejectedValue(new Error('redis unavailable'))
    const postgres = vi.fn().mockResolvedValue('postgres')
    const circuit = new RedisFallbackCircuit()

    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')
    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')
    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')
    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')

    expect(redis).toHaveBeenCalledTimes(3)
    expect(postgres).toHaveBeenCalledTimes(4)
    expect(circuit.status()).toEqual({ state: 'degraded', consecutiveFailures: 3, recoverySuccesses: 0 })
  })

  it('recovers only after three successful probes following the cooldown', async () => {
    let now = 0
    const redis = vi.fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockRejectedValueOnce(new Error('three'))
      .mockResolvedValue('redis')
    const postgres = vi.fn().mockResolvedValue('postgres')
    const circuit = new RedisFallbackCircuit({ now: () => now })

    await circuit.run(redis, postgres)
    await circuit.run(redis, postgres)
    await circuit.run(redis, postgres)
    now = 29_999
    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')
    now = 30_000
    await expect(circuit.run(redis, postgres)).resolves.toBe('redis')
    await expect(circuit.run(redis, postgres)).resolves.toBe('redis')
    expect(circuit.status().state).toBe('degraded')
    await expect(circuit.run(redis, postgres)).resolves.toBe('redis')

    expect(circuit.status()).toEqual({ state: 'healthy', consecutiveFailures: 0, recoverySuccesses: 0 })
    expect(redis).toHaveBeenCalledTimes(6)
  })

  it('allows only one concurrent recovery probe while other requests use PostgreSQL', async () => {
    let now = 0
    let releaseProbe: ((value: string) => void) | undefined
    const redis = vi.fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockRejectedValueOnce(new Error('three'))
      .mockImplementation(() => new Promise<string>((resolve) => { releaseProbe = resolve }))
    const postgres = vi.fn().mockResolvedValue('postgres')
    const circuit = new RedisFallbackCircuit({ now: () => now })
    await circuit.run(redis, postgres)
    await circuit.run(redis, postgres)
    await circuit.run(redis, postgres)

    now = 30_000
    const probe = circuit.run(redis, postgres)
    await expect(circuit.run(redis, postgres)).resolves.toBe('postgres')
    releaseProbe?.('redis')
    await expect(probe).resolves.toBe('redis')
    expect(redis).toHaveBeenCalledTimes(4)
  })

  it('treats a two-second Redis timeout as a failure and falls back', async () => {
    vi.useFakeTimers()
    const redis = vi.fn(() => new Promise<string>(() => undefined))
    const postgres = vi.fn().mockResolvedValue('postgres')
    const circuit = new RedisFallbackCircuit({ failureThreshold: 1 })

    const result = circuit.run(redis, postgres)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(result).resolves.toBe('postgres')
    expect(circuit.status().state).toBe('degraded')
  })
})
