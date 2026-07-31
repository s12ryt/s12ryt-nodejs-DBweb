import { describe, expect, it, vi } from 'vitest'

import { DependencyHealthService } from './dependency-health-service.js'

describe('DependencyHealthService', () => {
  it('Redis degraded時仍ready，但公開degraded摘要', async () => {
    const service = new DependencyHealthService({
      metadata: vi.fn(async () => undefined),
      objectStorage: vi.fn(async () => undefined),
      redisState: () => 'degraded',
    })

    await expect(service.check()).resolves.toEqual({
      ready: true,
      degraded: true,
      components: { metadata: 'up', objectStorage: 'up', redis: 'degraded' },
    })
  })

  it('metadata或必要object storage失效時not ready，錯誤內容不進snapshot', async () => {
    const service = new DependencyHealthService({
      metadata: vi.fn(async () => { throw new Error('postgres-password') }),
      objectStorage: vi.fn(async () => { throw new Error('s3-secret') }),
      redisState: () => 'healthy',
    })

    const snapshot = await service.check()
    expect(snapshot).toEqual({
      ready: false,
      degraded: false,
      components: { metadata: 'down', objectStorage: 'down', redis: 'up' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('password')
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('未配置Redis時顯示disabled而不視為degraded', async () => {
    const service = new DependencyHealthService({
      metadata: vi.fn(async () => undefined),
      objectStorage: vi.fn(async () => undefined),
    })
    await expect(service.check()).resolves.toMatchObject({
      ready: true,
      degraded: false,
      components: { redis: 'disabled' },
    })
  })
})
