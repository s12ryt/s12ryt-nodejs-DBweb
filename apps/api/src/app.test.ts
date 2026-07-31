import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { AuthService } from './auth/auth-service.js'
import { MemoryAuthRepository } from './auth/memory-auth-repository.js'
import { buildApp } from './app.js'

describe('authentication HTTP API', () => {
  const csrfSecret = Buffer.alloc(32, 7)
  let authService: AuthService

  beforeEach(async () => {
    authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    await authService.createUser({
      username: 'admin',
      password: 'correct horse battery staple',
      role: 'admin',
    })
  })

  const apps: FastifyInstance[] = []
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
  })

  async function createApp() {
    const app = await buildApp({ authService, csrfSecret, production: true })
    apps.push(app)
    return app
  }

  it('登入後設定安全 session cookie，並以 CSRF token 存取目前使用者', async () => {
    const app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery staple' },
    })

    expect(login.statusCode).toBe(200)
    expect(login.json()).toMatchObject({
      user: { username: 'admin', role: 'admin' },
      csrfToken: expect.any(String),
    })
    const cookie = login.headers['set-cookie']
    expect(cookie).toContain('dbweb_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie as string },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({
      user: { username: 'admin', role: 'admin' },
      csrfToken: login.json<{ csrfToken: string }>().csrfToken,
    })
  })

  it('未登入時以要求語言回傳一致的 401 錯誤', async () => {
    const app = await createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'accept-language': 'en' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
  })

  it('建立使用者需要管理員身份與有效 CSRF token', async () => {
    const app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery staple' },
    })
    const { csrfToken } = login.json<{ csrfToken: string }>()
    const cookie = login.headers['set-cookie'] as string

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'operator', password: 'valid operator password', role: 'user' },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { username: 'operator', password: 'valid operator password', role: 'user' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ username: 'operator', role: 'user' })
    expect(created.json()).not.toHaveProperty('passwordHash')
  })

  it('一般使用者即使有有效 session 與 CSRF token 也不能建立帳號', async () => {
    await authService.createUser({
      username: 'operator',
      password: 'valid operator password',
      role: 'user',
    })
    const app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'operator', password: 'valid operator password' },
    })
    const { csrfToken } = login.json<{ csrfToken: string }>()

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: {
        cookie: login.headers['set-cookie'] as string,
        'x-csrf-token': csrfToken,
      },
      payload: { username: 'other', password: 'another valid password', role: 'user' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  it('限制重複登入失敗嘗試', async () => {
    const app = await createApp()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'incorrect password' },
      })
      expect(response.statusCode).toBe(401)
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'incorrect password' },
    })
    expect(blocked.statusCode).toBe(429)
  })
})
