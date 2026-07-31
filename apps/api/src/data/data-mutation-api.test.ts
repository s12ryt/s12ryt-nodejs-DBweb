import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import {
  DataMutationError,
  type DataMutationService,
} from './data-mutation-service.js'

describe('data mutation HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup() {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const admin = await authService.createUser({
      username: 'admin',
      password: 'correct horse battery staple',
      role: 'admin',
    })
    const user = await authService.createUser({
      username: 'reader',
      password: 'correct horse battery staple',
      role: 'user',
    })
    const inspect = vi.fn(async () => ({
      table: {
        schema: 'public',
        name: 'orders',
        columns: [{ name: 'id', valueType: 'bigint', nullable: false, generated: true }],
        uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
      },
      policy: {
        identity: { name: 'orders_pkey', kind: 'primary', columns: ['id'] },
        writableColumns: [],
        readOnlyColumns: ['id'],
        canUpdate: true,
        canDelete: true,
      },
    }))
    const mutate = vi.fn(async () => ({ affectedRows: 1, items: [{ index: 0, affectedRows: 1 }] }))
    const mutationService = { inspect, mutate } as unknown as DataMutationService
    const app = await buildApp({
      authService,
      dataMutationService: mutationService,
      csrfSecret: Buffer.alloc(32, 6),
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

    return { app, admin, user, mutationService, inspect, mutate, login }
  }

  it('只有管理員可讀取 mutation capability', async () => {
    const { app, admin, inspect, login } = await setup()
    const adminSession = await login('admin')
    const userSession = await login('reader')
    const url = '/api/connections/c1/schemas/public/tables/orders/mutations'

    const anonymous = await app.inject({ method: 'GET', url })
    const forbidden = await app.inject({ method: 'GET', url, headers: { cookie: userSession.cookie } })
    const response = await app.inject({ method: 'GET', url, headers: { cookie: adminSession.cookie } })

    expect(anonymous.statusCode).toBe(401)
    expect(forbidden.statusCode).toBe(403)
    expect(response.statusCode).toBe(200)
    expect(inspect).toHaveBeenCalledWith(admin, {
      connectionId: 'c1', schema: 'public', table: 'orders',
    })
  })

  it('管理員帶 CSRF 可提交 tagged mutation，且一般使用者不可寫入', async () => {
    const { app, admin, mutate, login } = await setup()
    const adminSession = await login('admin')
    const userSession = await login('reader')
    const url = '/api/connections/c1/schemas/public/tables/orders/mutations'
    const payload = {
      operations: [{
        kind: 'insert',
        values: { note: { kind: 'value', type: 'string', value: '' } },
      }],
    }

    const noCsrf = await app.inject({ method: 'POST', url, headers: { cookie: adminSession.cookie }, payload })
    const forbidden = await app.inject({
      method: 'POST', url,
      headers: { cookie: userSession.cookie, 'x-csrf-token': userSession.csrfToken },
      payload,
    })
    const response = await app.inject({
      method: 'POST', url,
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrfToken },
      payload,
    })

    expect(noCsrf.statusCode).toBe(403)
    expect(forbidden.statusCode).toBe(403)
    expect(response.statusCode).toBe(200)
    expect(mutate).toHaveBeenCalledWith(admin, {
      connectionId: 'c1', schema: 'public', table: 'orders', operations: payload.operations,
    })
  })

  it('衝突回 409 與失敗列索引，driver 失敗只回安全訊息', async () => {
    const { app, mutate, login } = await setup()
    const session = await login('admin')
    const request = {
      method: 'POST' as const,
      url: '/api/connections/c1/schemas/public/tables/orders/mutations',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'accept-language': 'en' },
      payload: { operations: [{ kind: 'delete', confirmed: true, identity: {}, original: {} }] },
    }
    mutate.mockRejectedValueOnce(new DataMutationError('ROW_CONFLICT', 4))

    const conflict = await app.inject(request)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toEqual({
      error: { code: 'ROW_CONFLICT', message: 'The row changed or no longer exists', operationIndex: 4 },
    })

    mutate.mockRejectedValueOnce(new DataMutationError('MUTATION_FAILED'))
    const failed = await app.inject(request)
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toEqual({
      error: { code: 'MUTATION_FAILED', message: 'Data mutation failed' },
    })
  })
})
