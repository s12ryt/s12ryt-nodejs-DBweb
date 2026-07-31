import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import type { DatabaseExplorer } from '../database/database-explorer.js'
import type { DataMutationService } from '../data/data-mutation-service.js'
import type { DdlService } from '../ddl/ddl-service.js'
import type { SqlQueryService } from '../query/sql-query-service.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { MemoryWebAccessRepository, WebAccessService } from './web-access-service.js'

describe('web access HTTP API', () => {
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
    const reader = await authService.createUser({
      username: 'reader',
      password: 'another correct horse battery',
      role: 'user',
    })
    const connector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: '17.5' })) }
    const connectionService = new ConnectionService(
      new MemoryConnectionRepository(),
      new EnvelopeEncryption(Buffer.alloc(32, 4)),
      { postgres: connector, mysql: connector },
    )
    const connection = await connectionService.create({
      name: 'Main',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      username: 'dbweb',
      password: 'database-secret',
      tls: { mode: 'disable' },
      keepAlive: { enabled: false },
    }, admin.id)
    const explorer = {
      listSchemas: vi.fn(async () => ['public']),
      listTables: vi.fn(),
      describeTable: vi.fn(),
      readRows: vi.fn(),
    } as unknown as DatabaseExplorer
    const webAccessService = new WebAccessService(new MemoryWebAccessRepository())
    const queryService = {
      execute: vi.fn(async () => ({
        columns: ['value'], rows: [{ value: 1 }], affectedRows: 1, truncated: false, durationMs: 1,
      })),
      cancel: vi.fn(async () => true),
    } as unknown as SqlQueryService
    const dataMutationService = {
      inspect: vi.fn(async () => ({
        table: { schema: 'public', name: 'orders', columns: [], uniqueKeys: [] },
        policy: {
          identity: undefined,
          writableColumns: [],
          readOnlyColumns: [],
          canUpdate: false,
          canDelete: false,
        },
      })),
      mutate: vi.fn(),
    } as unknown as DataMutationService
    const ddlService = {
      capabilities: vi.fn(async () => ({ engine: 'postgres' })),
      execute: vi.fn(),
    } as unknown as DdlService
    const app = await buildApp({
      authService,
      connectionService,
      databaseExplorer: explorer,
      dataMutationService,
      ddlService,
      queryService,
      webAccessService,
      csrfSecret: Buffer.alloc(32, 6),
      production: false,
    })
    apps.push(app)

    async function login(username: string, password: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password },
      })
      return {
        cookie: response.headers['set-cookie'] as string,
        csrfToken: response.json<{ csrfToken: string }>().csrfToken,
      }
    }

    return {
      app,
      admin: await login('admin', 'correct horse battery staple'),
      reader: await login('reader', 'another correct horse battery'),
      readerId: reader.id,
      connectionId: connection.id,
      explorer,
      queryService,
      dataMutationService,
      ddlService,
    }
  }

  it('管理員配置 connection 能力後下一請求立即生效，撤銷後立即失效', async () => {
    const { app, admin, reader, readerId, connectionId, explorer } = await setup()

    const initiallyVisible = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { cookie: reader.cookie },
    })
    const initiallyDenied = await app.inject({
      method: 'GET',
      url: `/api/connections/${connectionId}/schemas`,
      headers: { cookie: reader.cookie, 'accept-language': 'en' },
    })
    expect(initiallyVisible.json()).toEqual([])
    expect(initiallyDenied.statusCode).toBe(403)
    expect(initiallyDenied.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
    expect(explorer.listSchemas).not.toHaveBeenCalled()

    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { capabilities: ['structure-read'] },
    })
    expect(assigned.statusCode).toBe(200)
    expect(assigned.json()).toEqual({
      userId: readerId,
      connectionId,
      capabilities: ['structure-read'],
    })

    const visible = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { cookie: reader.cookie },
    })
    const allowed = await app.inject({
      method: 'GET',
      url: `/api/connections/${connectionId}/schemas`,
      headers: { cookie: reader.cookie },
    })
    expect(visible.json()).toHaveLength(1)
    expect(visible.json<Array<{ id: string }>>()[0]?.id).toBe(connectionId)
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toEqual(['public'])

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    expect(revoked.statusCode).toBe(204)
    const deniedAgain = await app.inject({
      method: 'GET',
      url: `/api/connections/${connectionId}/schemas`,
      headers: { cookie: reader.cookie },
    })
    expect(deniedAgain.statusCode).toBe(403)
    expect(explorer.listSchemas).toHaveBeenCalledTimes(1)
  })

  it('一般使用者不能配置其他使用者的 connection 能力', async () => {
    const { app, reader, readerId, connectionId } = await setup()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: reader.cookie, 'x-csrf-token': reader.csrfToken },
      payload: { capabilities: ['structure-read'] },
    })

    expect(response.statusCode).toBe(403)
  })

  it('管理員可列出指定使用者的現有connection能力', async () => {
    const { app, admin, reader, readerId, connectionId } = await setup()
    await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { capabilities: ['data-read'] },
    })

    const listed = await app.inject({
      method: 'GET',
      url: `/api/users/${readerId}/access`,
      headers: { cookie: admin.cookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual([{
      userId: readerId,
      connectionId,
      capabilities: ['structure-read', 'data-read'],
    }])

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/users/${readerId}/access`,
      headers: { cookie: reader.cookie },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('query-read授權只允許一般使用者以唯讀模式執行SQL', async () => {
    const { app, admin, reader, readerId, connectionId, queryService } = await setup()
    const payload = {
      queryId: '77777777-7777-4777-8777-777777777777',
      connectionId,
      sql: 'SELECT 1',
    }
    const denied = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: { cookie: reader.cookie, 'x-csrf-token': reader.csrfToken },
      payload,
    })
    expect(denied.statusCode).toBe(403)
    expect(queryService.execute).not.toHaveBeenCalled()

    await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { capabilities: ['query-read'] },
    })
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: { cookie: reader.cookie, 'x-csrf-token': reader.csrfToken },
      payload,
    })

    expect(allowed.statusCode).toBe(200)
    expect(queryService.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ connectionId }),
      { readOnly: true },
    )
  })

  it('data-write與ddl-write分別控制資料異動及結構管理', async () => {
    const {
      app, admin, reader, readerId, connectionId, dataMutationService, ddlService,
    } = await setup()
    const mutationUrl = `/api/connections/${connectionId}/schemas/public/tables/orders/mutations`
    const ddlUrl = `/api/connections/${connectionId}/ddl/capabilities`

    expect((await app.inject({
      method: 'GET', url: mutationUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(403)
    expect((await app.inject({
      method: 'GET', url: ddlUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(403)

    await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { capabilities: ['data-write'] },
    })
    expect((await app.inject({
      method: 'GET', url: mutationUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'GET', url: ddlUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(403)
    expect(dataMutationService.inspect).toHaveBeenCalledOnce()
    expect(ddlService.capabilities).not.toHaveBeenCalled()

    await app.inject({
      method: 'PUT',
      url: `/api/users/${readerId}/connections/${connectionId}/access`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { capabilities: ['ddl-write'] },
    })
    expect((await app.inject({
      method: 'GET', url: mutationUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(403)
    expect((await app.inject({
      method: 'GET', url: ddlUrl, headers: { cookie: reader.cookie },
    })).statusCode).toBe(200)
    expect(ddlService.capabilities).toHaveBeenCalledOnce()
  })
})
