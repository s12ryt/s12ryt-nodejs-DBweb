import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { DdlValidationError } from './ddl-command.js'
import { DdlServiceError, type DdlService } from './ddl-service.js'

describe('DDL HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup() {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const admin = await authService.createUser({
      username: 'admin', password: 'correct horse battery staple', role: 'admin',
    })
    await authService.createUser({
      username: 'reader', password: 'correct horse battery staple', role: 'user',
    })
    const capabilities = vi.fn(async () => ({
      engine: 'postgres',
      version: { major: 17, minor: 5, patch: 0, assumedMinimum: false },
      transactionalDdl: true,
      columnTypes: ['bigint'],
    }))
    const execute = vi.fn(async () => ({ statementsExecuted: 1, transactional: true }))
    const ddlService = { capabilities, execute } as unknown as DdlService
    const app = await buildApp({
      authService,
      ddlService,
      csrfSecret: Buffer.alloc(32, 8),
      production: false,
    })
    apps.push(app)

    async function login(username: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password: 'correct horse battery staple' },
      })
      return {
        cookie: response.headers['set-cookie'] as string,
        csrfToken: response.json<{ csrfToken: string }>().csrfToken,
      }
    }

    return { app, admin, capabilities, execute, login }
  }

  it('只有管理員可依資料庫真實版本讀取 DDL capabilities', async () => {
    const { app, admin, capabilities, login } = await setup()
    const adminSession = await login('admin')
    const userSession = await login('reader')
    const url = '/api/connections/c1/ddl/capabilities'

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET', url, headers: { cookie: userSession.cookie },
    })).statusCode).toBe(403)
    const response = await app.inject({
      method: 'GET', url, headers: { cookie: adminSession.cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ engine: 'postgres', transactionalDdl: true })
    expect(capabilities).toHaveBeenCalledWith(admin, 'c1')
  })

  it('管理員帶 CSRF 執行結構化 DDL command', async () => {
    const { app, admin, execute, login } = await setup()
    const session = await login('admin')
    const url = '/api/connections/c1/ddl/execute'
    const command = {
      kind: 'create-table', schema: 'public', name: 'orders',
      columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
    }

    expect((await app.inject({
      method: 'POST', url, headers: { cookie: session.cookie }, payload: { command },
    })).statusCode).toBe(403)
    const response = await app.inject({
      method: 'POST', url,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { command },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ statementsExecuted: 1, transactional: true })
    expect(execute).toHaveBeenCalledWith(admin, { connectionId: 'c1', command })
  })

  it('接受需加密稽核的進階程式碼物件 command', async () => {
    const { app, admin, execute, login } = await setup()
    const session = await login('admin')
    const command = {
      kind: 'create-routine' as const,
      routineKind: 'function' as const,
      schema: 'public',
      name: 'mask_email',
      arguments: [],
      returns: { name: 'text' },
      language: 'sql',
      body: "SELECT 'classified-body'",
      confirmed: true,
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/connections/c1/ddl/execute',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { command },
    })

    expect(response.statusCode).toBe(200)
    expect(execute).toHaveBeenCalledWith(admin, { connectionId: 'c1', command })
  })

  it('映射確認、驗證與 driver 錯誤，且不洩漏底層訊息', async () => {
    const { app, execute, login } = await setup()
    const session = await login('admin')
    const request = {
      method: 'POST' as const,
      url: '/api/connections/c1/ddl/execute',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        'accept-language': 'en',
      },
      payload: { command: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: false } },
    }

    execute.mockRejectedValueOnce(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
    const confirmation = await app.inject(request)
    expect(confirmation.statusCode).toBe(409)
    expect(confirmation.json()).toEqual({
      error: { code: 'DDL_CONFIRMATION_REQUIRED', message: 'DDL confirmation required' },
    })

    execute.mockRejectedValueOnce(new DdlValidationError('DDL_TYPE_UNSUPPORTED'))
    expect((await app.inject(request)).statusCode).toBe(422)

    execute.mockRejectedValueOnce(new DdlServiceError('DDL_FAILED'))
    const failed = await app.inject(request)
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toEqual({
      error: { code: 'DDL_FAILED', message: 'DDL execution failed' },
    })
  })
})
