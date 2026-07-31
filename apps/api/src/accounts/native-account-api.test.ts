import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryWebAccessRepository, WebAccessService } from '../access/web-access-service.js'
import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { NativeAccountService } from './native-account-service.js'
import { NativeGrantServiceError, type NativeGrantService } from './native-grant-service.js'

describe('native account HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup() {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000, absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const admin = await authService.createUser({ username: 'admin', password: 'admin-password-value', role: 'admin' })
    const manager = await authService.createUser({ username: 'manager', password: 'manager-password-value', role: 'user' })
    const connectionService = new ConnectionService(
      new MemoryConnectionRepository(),
      new EnvelopeEncryption(Buffer.alloc(32, 3)),
      { postgres: { test: vi.fn() }, mysql: { test: vi.fn() } },
    )
    const connection = await connectionService.create({
      name: 'Main', engine: 'postgres', host: 'localhost', port: 5432, database: 'app',
      username: 'dbweb', password: 'connection-secret', tls: { mode: 'disable' },
      keepAlive: { enabled: false },
    }, admin.id)
    const webAccessService = new WebAccessService(new MemoryWebAccessRepository())
    const account = {
      id: 'account-1', connectionId: connection.id,
      identity: { engine: 'postgres' as const, username: 'reporter' },
      encryptedPassword: 'ciphertext', verificationDatabase: 'app', verificationIntervalMs: 21_600_000,
      canLogin: true, connectionLimit: -1, status: 'active' as const, verificationFailures: 0,
      nextVerificationAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    }
    const nativeAccountService = {
      list: vi.fn(async () => [{
        identity: account.identity, canLogin: true, passwordExpired: false, connectionLimit: -1,
        systemAccount: false, managed: true, managedAccountId: account.id, protected: false,
      }]),
      create: vi.fn(async (actor) => ({ account, ...(actor.role === 'admin' ? { password: 'generated-native-password-value' } : {}) })),
      adopt: vi.fn(async () => ({ account })),
      rotatePassword: vi.fn(async () => ({ account })),
      verifyNow: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined), revealPassword: vi.fn(async () => 'managed-native-password'),
    } as unknown as NativeAccountService
    const nativeGrantService = {
      list: vi.fn(async () => [{ scope: 'database', database: 'analytics', privileges: ['connect'] }]),
      execute: vi.fn(async () => ({ appliedCount: 2 })),
    } as unknown as NativeGrantService
    const app = await buildApp({
      authService, connectionService, webAccessService, nativeAccountService, nativeGrantService,
      csrfSecret: Buffer.alloc(32, 5), production: false,
    })
    apps.push(app)
    async function login(username: string, password: string) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
      return {
        cookie: response.cookies[0]!.value,
        csrf: response.json().csrfToken as string,
      }
    }
    return {
      admin, app, connection, login, manager, nativeAccountService, nativeGrantService, webAccessService,
    }
  }

  it('enforces account-manage on every list and create request without exposing manager credentials', async () => {
    const environment = await setup()
    const session = await environment.login('manager', 'manager-password-value')
    const headers = { cookie: `dbweb_session=${session.cookie}`, 'x-csrf-token': session.csrf }
    expect((await environment.app.inject({
      method: 'GET', url: `/api/connections/${environment.connection.id}/accounts`, headers,
    })).statusCode).toBe(403)

    await environment.webAccessService.assign(environment.admin, environment.manager.id, environment.connection.id, ['account-manage'])
    expect((await environment.app.inject({
      method: 'GET', url: `/api/connections/${environment.connection.id}/accounts`, headers,
    })).statusCode).toBe(200)
    const created = await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts`, headers,
      payload: { identity: { username: 'reporter' }, confirmed: true },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).not.toHaveProperty('password')
    expect(created.json().account).not.toHaveProperty('encryptedPassword')
  })

  it('returns a generated password once to administrators and requires reauthentication to reveal it', async () => {
    const environment = await setup()
    const session = await environment.login('admin', 'admin-password-value')
    const headers = { cookie: `dbweb_session=${session.cookie}`, 'x-csrf-token': session.csrf }
    const created = await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts`, headers,
      payload: { identity: { username: 'reporter' }, confirmed: true },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().password).toBe('generated-native-password-value')
    expect(created.json().account).not.toHaveProperty('encryptedPassword')

    const revealed = await environment.app.inject({
      method: 'POST',
      url: `/api/connections/${environment.connection.id}/accounts/account-1/reveal-password`,
      headers,
      payload: { webPassword: 'admin-password-value' },
    })
    expect(revealed.statusCode).toBe(200)
    expect(revealed.json()).toEqual({ password: 'managed-native-password' })
    expect(environment.nativeAccountService.revealPassword).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.admin.id }),
      'account-1',
      'admin-password-value',
    )
  })

  it('maps lifecycle commands to confirmed service operations', async () => {
    const environment = await setup()
    const session = await environment.login('admin', 'admin-password-value')
    const headers = { cookie: `dbweb_session=${session.cookie}`, 'x-csrf-token': session.csrf }
    expect((await environment.app.inject({
      method: 'PATCH', url: `/api/connections/${environment.connection.id}/accounts/account-1`,
      headers, payload: { enabled: false, confirmed: true },
    })).statusCode).toBe(204)
    expect((await environment.app.inject({
      method: 'DELETE', url: `/api/connections/${environment.connection.id}/accounts/account-1`,
      headers, payload: { confirmed: true },
    })).statusCode).toBe(204)
    expect((await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts/account-1/restore`,
      headers, payload: { confirmed: true },
    })).statusCode).toBe(204)
    expect((await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts/adopt`,
      headers, payload: { identity: { username: 'external' }, confirmed: true },
    })).statusCode).toBe(201)
    expect((await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts/account-1/rotate-password`,
      headers, payload: {},
    })).statusCode).toBe(200)
    expect((await environment.app.inject({
      method: 'POST', url: `/api/connections/${environment.connection.id}/accounts/account-1/verify`,
      headers, payload: {},
    })).statusCode).toBe(204)
  })

  it('lists and changes actual grants with immediate account-manage enforcement', async () => {
    const environment = await setup()
    const session = await environment.login('manager', 'manager-password-value')
    const headers = { cookie: `dbweb_session=${session.cookie}`, 'x-csrf-token': session.csrf }
    const url = `/api/connections/${environment.connection.id}/accounts/grants`
    const query = '?targetDatabase=analytics&engine=postgres&username=reader'

    expect((await environment.app.inject({ method: 'GET', url: `${url}${query}`, headers })).statusCode)
      .toBe(403)
    await environment.webAccessService.assign(
      environment.admin,
      environment.manager.id,
      environment.connection.id,
      ['account-manage'],
    )
    const listed = await environment.app.inject({ method: 'GET', url: `${url}${query}`, headers })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual([
      { scope: 'database', database: 'analytics', privileges: ['connect'] },
    ])

    const command = {
      kind: 'revoke', confirmed: true,
      identity: { engine: 'postgres', username: 'reader' },
      changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
    }
    const changed = await environment.app.inject({ method: 'POST', url, headers, payload: command })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toEqual({ appliedCount: 2 })
    expect(environment.nativeGrantService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.manager.id }),
      environment.connection.id,
      command,
    )
  })

  it('returns safe partial progress for nontransactional grant failures', async () => {
    const environment = await setup()
    environment.nativeGrantService.execute = vi.fn(async () => {
      throw new NativeGrantServiceError('NATIVE_GRANT_FAILED', 1, 1)
    })
    const session = await environment.login('admin', 'admin-password-value')
    const response = await environment.app.inject({
      method: 'POST',
      url: `/api/connections/${environment.connection.id}/accounts/grants`,
      headers: {
        cookie: `dbweb_session=${session.cookie}`,
        'x-csrf-token': session.csrf,
      },
      payload: {
        kind: 'grant', identity: { engine: 'postgres', username: 'reader' },
        changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      error: {
        code: 'NATIVE_GRANT_FAILED',
        message: '原生資料庫權限異動失敗',
        appliedCount: 1,
        failedIndex: 1,
      },
    })
  })
})
