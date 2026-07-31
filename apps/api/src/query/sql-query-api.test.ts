import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { QueryError, type SqlQueryService } from './sql-query-service.js'

describe('SQL query HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup(execute = vi.fn(async () => ({
    columns: ['value'],
    rows: [{ value: 1 }],
    affectedRows: 1,
    truncated: false,
    durationMs: 2,
  }))) {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const user = await authService.createUser({
      username: 'reader',
      password: 'correct horse battery staple',
      role: 'user',
    })
    const queryService = {
      execute,
      cancel: vi.fn(async () => true),
    } as unknown as SqlQueryService
    const app = await buildApp({
      authService,
      queryService,
      csrfSecret: Buffer.alloc(32, 6),
      production: false,
    })
    apps.push(app)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'reader', password: 'correct horse battery staple' },
    })
    return {
      app,
      user,
      queryService,
      cookie: login.headers['set-cookie'] as string,
      csrfToken: login.json<{ csrfToken: string }>().csrfToken,
    }
  }

  it('一般使用者帶 CSRF 可執行自訂限制的 SQL', async () => {
    const { app, user, queryService, cookie, csrfToken } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        queryId: '11111111-1111-4111-8111-111111111111',
        connectionId: 'connection-1',
        sql: 'SELECT 1',
        timeoutMs: 20_000,
        rowLimit: 500,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(queryService.execute).toHaveBeenCalledWith(user.id, expect.objectContaining({ rowLimit: 500 }))
  })

  it('缺 CSRF 時拒絕執行，且高風險未確認回傳 409', async () => {
    const execute = vi.fn(async () => {
      throw new QueryError('CONFIRMATION_REQUIRED')
    })
    const { app, cookie, csrfToken } = await setup(execute)
    const payload = {
      queryId: '22222222-2222-4222-8222-222222222222',
      connectionId: 'connection-1',
      sql: 'DROP TABLE users',
    }
    const noCsrf = await app.inject({ method: 'POST', url: '/api/queries', headers: { cookie }, payload })
    expect(noCsrf.statusCode).toBe(403)

    const confirmation = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: { cookie, 'x-csrf-token': csrfToken, 'accept-language': 'en' },
      payload,
    })
    expect(confirmation.statusCode).toBe(409)
    expect(confirmation.json()).toEqual({
      error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirmation required for high-risk SQL' },
    })
  })

  it('可取消本人的執行中查詢', async () => {
    const { app, user, queryService, cookie, csrfToken } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/queries/33333333-3333-4333-8333-333333333333/cancel',
      headers: { cookie, 'x-csrf-token': csrfToken },
    })

    expect(response.statusCode).toBe(204)
    expect(queryService.cancel).toHaveBeenCalledWith(user.id, '33333333-3333-4333-8333-333333333333')
  })
})
