import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { DatabaseConnectionError } from '../connections/connector-error.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import type { DatabaseExplorer } from './database-explorer.js'

describe('database explorer HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup(explorerOverrides: Partial<DatabaseExplorer> = {}) {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    await authService.createUser({
      username: 'reader',
      password: 'correct horse battery staple',
      role: 'user',
    })
    const explorer = {
      listSchemas: vi.fn(async () => ['public']),
      listTables: vi.fn(async () => [{ schema: 'public', name: 'order items', type: 'table' as const }]),
      describeTable: vi.fn(async () => [
        { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
      ]),
      readRows: vi.fn(async () => ({ columns: ['id'], rows: [{ id: 1 }], nextOffset: null })),
      ...explorerOverrides,
    } as unknown as DatabaseExplorer
    const app = await buildApp({
      authService,
      databaseExplorer: explorer,
      csrfSecret: Buffer.alloc(32, 6),
      production: false,
    })
    apps.push(app)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'reader', password: 'correct horse battery staple' },
    })
    return { app, cookie: login.headers['set-cookie'] as string, explorer }
  }

  it('拒絕未登入瀏覽，登入後可瀏覽 schema、table、column 與分頁資料', async () => {
    const { app, cookie, explorer } = await setup()
    const anonymous = await app.inject({ method: 'GET', url: '/api/connections/c1/schemas' })
    expect(anonymous.statusCode).toBe(401)

    const headers = { cookie }
    const schemas = await app.inject({ method: 'GET', url: '/api/connections/c1/schemas', headers })
    const tables = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas/public/tables',
      headers,
    })
    const columns = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas/public/tables/order%20items/columns',
      headers,
    })
    const rows = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas/public/tables/order%20items/rows?limit=25&offset=50',
      headers,
    })

    expect(schemas.json()).toEqual(['public'])
    expect(tables.json()).toEqual([{ schema: 'public', name: 'order items', type: 'table' }])
    expect(columns.json()).toEqual([
      { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
    ])
    expect(rows.json()).toEqual({ columns: ['id'], rows: [{ id: 1 }], nextOffset: null })
    expect(explorer.readRows).toHaveBeenCalledWith('c1', 'public', 'order items', {
      limit: 25,
      offset: 50,
    })
  })

  it('driver 錯誤只回傳本地化安全訊息', async () => {
    const { app, cookie } = await setup({
      listSchemas: vi.fn(async () => {
        throw new DatabaseConnectionError()
      }),
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas',
      headers: { cookie, 'accept-language': 'en' },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      error: { code: 'DATABASE_CONNECTION_FAILED', message: 'Database connection failed' },
    })
  })

  it('將不透明keyset cursor與方向交給Explorer，並在HTTP邊界限制offset', async () => {
    const cursor = 'eyJ2IjoxLCJrZXkiOlsiaWQiXSwidmFsdWVzIjpbNDJdLCJkaXJlY3Rpb24iOiJmb3J3YXJkIn0'
    const readRows = vi.fn(async () => ({
      columns: ['id'],
      rows: [{ id: 43 }],
      paginationMode: 'keyset' as const,
      nextCursor: null,
      previousCursor: 'previous',
    }))
    const { app, cookie } = await setup({ readRows } as Partial<DatabaseExplorer>)

    const response = await app.inject({
      method: 'GET',
      url: `/api/connections/c1/schemas/public/tables/orders/rows?limit=50&cursor=${cursor}&direction=forward`,
      headers: { cookie },
    })
    const tooDeep = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas/public/tables/orders/rows?offset=100001',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(readRows).toHaveBeenCalledWith('c1', 'public', 'orders', {
      limit: 50,
      offset: 0,
      cursor,
      direction: 'forward',
    })
    expect(tooDeep.statusCode).toBe(400)
  })

  it('資料庫操作配額忙碌時回可重試503且不洩漏租約資訊', async () => {
    const { app, cookie } = await setup({
      listSchemas: vi.fn(async () => {
        throw new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true)
      }),
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas',
      headers: { cookie, 'accept-language': 'en' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.json()).toEqual({
      error: { code: 'DATABASE_OPERATION_BUSY', message: 'Database operation capacity is busy' },
    })
    expect(response.body).not.toContain('lease')
    expect(response.body).not.toContain('owner')
  })
})
