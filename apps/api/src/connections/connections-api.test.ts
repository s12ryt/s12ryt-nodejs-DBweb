import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { ConnectionService } from './connection-service.js'
import { MemoryConnectionRepository } from './memory-connection-repository.js'

describe('connections HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup() {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    await authService.createUser({
      username: 'admin',
      password: 'correct horse battery staple',
      role: 'admin',
    })
    const connector = { test: vi.fn(async () => ({ latencyMs: 4, serverVersion: '16.3' })) }
    const connectionService = new ConnectionService(
      new MemoryConnectionRepository(),
      new EnvelopeEncryption(Buffer.alloc(32, 5)),
      { postgres: connector, mysql: connector },
    )
    const app = await buildApp({
      authService,
      connectionService,
      csrfSecret: Buffer.alloc(32, 6),
      production: true,
    })
    apps.push(app)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery staple' },
    })
    return {
      app,
      cookie: login.headers['set-cookie'] as string,
      csrfToken: login.json<{ csrfToken: string }>().csrfToken,
    }
  }

  it('管理員可建立、列出與測試連線，回應永不包含 secret', async () => {
    const { app, cookie, csrfToken } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Main',
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'app',
        username: 'reader',
        password: 'database-secret',
        tls: { mode: 'disable' },
        keepAlive: { enabled: false },
      },
    })

    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('database-secret')
    const profile = created.json<{ id: string }>()

    const listed = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toHaveLength(1)
    expect(listed.body).not.toContain('database-secret')

    const tested = await app.inject({
      method: 'POST',
      url: `/api/connections/${profile.id}/test`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    })
    expect(tested.statusCode).toBe(200)
    expect(tested.json()).toEqual({ latencyMs: 4, serverVersion: '16.3' })
  })

  it('管理員可建立 SSH tunnel 連線，回應只包含公開 SSH 設定', async () => {
    const { app, cookie, csrfToken } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Remote',
        engine: 'mysql',
        host: 'mysql.private',
        port: 3306,
        database: 'app',
        username: 'reader',
        password: 'database-secret',
        tls: { mode: 'disable' },
        keepAlive: { enabled: false },
        ssh: {
          enabled: true,
          host: 'ssh.example.test',
          port: 2222,
          username: 'operator',
          password: 'ssh-secret',
        },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      ssh: {
        enabled: true,
        host: 'ssh.example.test',
        port: 2222,
        username: 'operator',
      },
    })
    expect(response.body).not.toContain('database-secret')
    expect(response.body).not.toContain('ssh-secret')
  })
})
