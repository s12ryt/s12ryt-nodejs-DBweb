import { describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'

function auth() {
  return new AuthService(new MemoryAuthRepository(), {
    idleTimeoutMs: 30 * 60_000,
    absoluteTimeoutMs: 12 * 60 * 60_000,
    passwordHashOptions: { memoryCost: 1024, timeCost: 1 },
  })
}

describe('HA health API', () => {
  it('liveness只表示程序存活，Redis降級仍ready並公開安全摘要', async () => {
    const app = await buildApp({
      authService: auth(),
      csrfSecret: Buffer.alloc(32, 1),
      production: false,
      healthService: {
        check: async () => ({
          ready: true,
          degraded: true,
          components: { metadata: 'up', objectStorage: 'up', redis: 'degraded' },
        }),
      },
    })

    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).json())
      .toEqual({ status: 'live' })
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ status: 'ready', degraded: true })
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      status: 'degraded',
      components: { metadata: 'up', objectStorage: 'up', redis: 'degraded' },
    })
    await app.close()
  })

  it('metadata或必要object storage失效時readiness回503但liveness仍200', async () => {
    const app = await buildApp({
      authService: auth(),
      csrfSecret: Buffer.alloc(32, 1),
      production: false,
      healthService: {
        check: async () => ({
          ready: false,
          degraded: false,
          components: { metadata: 'down', objectStorage: 'up', redis: 'disabled' },
        }),
      },
    })

    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).statusCode).toBe(200)
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toEqual({ status: 'not-ready', degraded: false })
    await app.close()
  })
})
