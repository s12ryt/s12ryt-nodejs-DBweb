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
    expect(created.json()).toMatchObject({
      user: { username: 'operator', role: 'user', passwordChangeRequired: true },
      temporaryPassword: 'valid operator password',
    })
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

  it('管理員可建立臨時密碼使用者、列出帳號並停用後立即撤銷其session', async () => {
    const app = await createApp()
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery staple' },
    })
    const adminHeaders = {
      cookie: adminLogin.headers['set-cookie'] as string,
      'x-csrf-token': adminLogin.json<{ csrfToken: string }>().csrfToken,
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminHeaders,
      payload: { username: 'operator', role: 'user' },
    })

    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      user: { username: 'operator', enabled: true, passwordChangeRequired: true },
      temporaryPassword: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/),
    })
    const temporaryPassword = created.json<{ temporaryPassword: string }>().temporaryPassword
    const operatorLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'operator', password: temporaryPassword },
    })
    expect(operatorLogin.statusCode).toBe(200)

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: adminHeaders })
    const operator = users.json<Array<{ id: string; username: string }>>().find(
      (user) => user.username === 'operator',
    )
    expect(users.statusCode).toBe(200)
    expect(operator).toBeDefined()

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${operator?.id}`,
      headers: adminHeaders,
      payload: { enabled: false },
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({ enabled: false })

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: operatorLogin.headers['set-cookie'] as string },
    })
    expect(revoked.statusCode).toBe(401)
  })

  it('強制改密碼帳號只能先變更本人密碼，變更後舊session失效', async () => {
    const admin = await authService.login('admin', 'correct horse battery staple')
    const operator = await authService.createUser({
      username: 'operator',
      password: 'operator password 123',
      role: 'user',
    })
    const reset = await authService.resetUserPassword(admin.user, operator.id, 'temporary password 123')
    expect(reset.user.passwordChangeRequired).toBe(true)
    const app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'operator', password: 'temporary password 123' },
    })
    const headers = {
      cookie: login.headers['set-cookie'] as string,
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
    }

    const blocked = await app.inject({ method: 'GET', url: '/api/users', headers })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json()).toMatchObject({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } })

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: 'temporary password 123', newPassword: 'new operator password 456' },
    })
    expect(changed.statusCode).toBe(204)

    const oldSession = await app.inject({ method: 'GET', url: '/api/auth/me', headers })
    expect(oldSession.statusCode).toBe(401)
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'operator', password: 'new operator password 456' },
    })
    expect(newLogin.statusCode).toBe(200)
    expect(newLogin.json()).toMatchObject({ user: { passwordChangeRequired: false } })
  })

  it('管理員可重設、升降角色及確認刪除，但不能移除最後一位可用管理員', async () => {
    const app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery staple' },
    })
    const headers = {
      cookie: login.headers['set-cookie'] as string,
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
    }
    const listed = await app.inject({ method: 'GET', url: '/api/users', headers })
    const admin = listed.json<Array<{ id: string }>>()[0]

    const protectedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/users/${admin?.id}`,
      headers,
      payload: { confirmed: true },
    })
    expect(protectedDelete.statusCode).toBe(409)
    expect(protectedDelete.json()).toMatchObject({ error: { code: 'LAST_ENABLED_ADMIN' } })

    const created = await authService.createUser({
      username: 'operator',
      password: 'operator password 123',
      role: 'user',
    })
    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/users/${created.id}`,
      headers,
      payload: { role: 'admin' },
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json()).toMatchObject({ role: 'admin' })

    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${created.id}/reset-password`,
      headers,
      payload: {},
    })
    expect(reset.statusCode).toBe(200)
    expect(reset.json()).toMatchObject({ temporaryPassword: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) })

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${created.id}`,
      headers,
      payload: { confirmed: true },
    })
    expect(deleted.statusCode).toBe(204)
  })
})
