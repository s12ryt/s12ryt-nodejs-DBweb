import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { SecurityAuditRecorder } from '../security/security-audit.js'
import { NativeAccountCredentialVault } from './native-account-credential.js'
import {
  MemoryNativeAccountRepository,
  NativeAccountService,
  NativeAccountServiceError,
  type ActualNativeAccount,
  type NativeAccountGateway,
} from './native-account-service.js'

const admin: AuthUser = {
  id: 'admin-1',
  username: 'admin',
  role: 'admin',
  enabled: true,
  passwordChangeRequired: false,
}
const manager: AuthUser = { ...admin, id: 'user-1', username: 'manager', role: 'user' }
const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'PostgreSQL',
  engine: 'postgres',
  host: 'database.test',
  port: 5432,
  database: 'app',
  username: 'dbweb_runtime',
  password: 'database-secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

function setup(
  authorize = vi.fn(async (actor: Pick<AuthUser, 'id' | 'role'>) => actor.role === 'admin'),
  reauthenticate = vi.fn(async (_actorId: string, password: string) => password === 'web-password'),
  securityAudit: SecurityAuditRecorder = { record: vi.fn(async () => undefined) },
) {
  const repository = new MemoryNativeAccountRepository()
  const actualAccounts: ActualNativeAccount[] = [
    { identity: { engine: 'postgres', username: 'dbweb_runtime' }, canLogin: true, passwordExpired: false, connectionLimit: -1, systemAccount: false },
    { identity: { engine: 'postgres', username: 'postgres' }, canLogin: true, passwordExpired: false, connectionLimit: -1, systemAccount: true },
    { identity: { engine: 'postgres', username: 'reporter' }, canLogin: true, passwordExpired: false, connectionLimit: 4, systemAccount: false },
  ]
  const gateway: NativeAccountGateway = {
    listAccounts: vi.fn(async (): Promise<ActualNativeAccount[]> => structuredClone(actualAccounts)),
    createAccount: vi.fn(async (_connection, request) => {
      actualAccounts.push({
        identity: request.identity,
        canLogin: request.canLogin,
        passwordExpired: false,
        connectionLimit: request.connectionLimit,
        systemAccount: false,
      })
    }),
    rotatePassword: vi.fn(async () => undefined),
    setAccountEnabled: vi.fn(async (_connection, identity, enabled) => {
      const account = actualAccounts.find((candidate) => JSON.stringify(candidate.identity) === JSON.stringify(identity))
      if (account) account.canLogin = enabled
    }),
    deleteAccount: vi.fn(async (_connection, identity) => {
      const index = actualAccounts.findIndex((candidate) => JSON.stringify(candidate.identity) === JSON.stringify(identity))
      if (index >= 0) actualAccounts.splice(index, 1)
    }),
    verifyCredential: vi.fn(async () => undefined),
  }
  const resolver = { resolveConnection: vi.fn(async () => connection) }
  const service = new NativeAccountService(
    resolver,
    { postgres: gateway, mysql: gateway },
    repository,
    new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 4))),
    authorize,
    () => new Date('2026-07-31T00:00:00.000Z'),
    reauthenticate,
    securityAudit,
  )
  return { authorize, gateway, reauthenticate, repository, resolver, securityAudit, service }
}

describe('NativeAccountService', () => {
  it('lists actual database accounts and marks connection and system identities protected', async () => {
    const { service } = setup()
    const accounts = await service.list(admin, 'connection-1')

    expect(accounts).toEqual([
      expect.objectContaining({ identity: { engine: 'postgres', username: 'dbweb_runtime' }, protected: true, protectionReason: 'connection-account', managed: false }),
      expect.objectContaining({ identity: { engine: 'postgres', username: 'postgres' }, protected: true, protectionReason: 'system-account', managed: false }),
      expect.objectContaining({ identity: { engine: 'postgres', username: 'reporter' }, protected: false, managed: false, connectionLimit: 4 }),
    ])
  })

  it('requires confirmation and authorization before creating an account', async () => {
    const { gateway, resolver, service } = setup(vi.fn(async () => false))
    await expect(
      service.create(manager, {
        connectionId: 'connection-1',
        identity: { username: 'reporter' },
        confirmed: true,
      }),
    ).rejects.toEqual(new NativeAccountServiceError('FORBIDDEN'))
    expect(resolver.resolveConnection).not.toHaveBeenCalled()

    const allowed = setup()
    await expect(
      allowed.service.create(admin, {
        connectionId: 'connection-1',
        identity: { username: 'reporter' },
        confirmed: false,
      }),
    ).rejects.toEqual(new NativeAccountServiceError('CONFIRMATION_REQUIRED'))
    expect(gateway.createAccount).not.toHaveBeenCalled()
  })

  it('encrypts generated credentials and only returns the one-time password to administrators', async () => {
    const { gateway, repository, service } = setup(vi.fn(async () => true))
    const created = await service.create(admin, {
      connectionId: 'connection-1',
      identity: { username: 'reporter' },
      confirmed: true,
    })

    expect(created.password).toHaveLength(32)
    expect(gateway.createAccount).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        identity: { engine: 'postgres', username: 'reporter' },
        password: created.password,
        canLogin: true,
        connectionLimit: -1,
      }),
    )
    const stored = await repository.findByIdentity(
      'connection-1',
      { engine: 'postgres', username: 'reporter' },
    )
    expect(stored?.encryptedPassword).not.toContain(created.password)
    expect(JSON.stringify(stored)).not.toContain(created.password)

    const regularResult = await setup(vi.fn(async () => true)).service.create(manager, {
      connectionId: 'connection-1',
      identity: { username: 'analyst' },
      password: 'manual-password-strong',
      confirmed: true,
    })
    expect(regularResult).not.toHaveProperty('password')
  })

  it('adopts an external account only after rotating its password and rejects protected accounts', async () => {
    const { gateway, repository, service } = setup(vi.fn(async () => true))
    const adopted = await service.adopt(admin, {
      connectionId: 'connection-1',
      identity: { username: 'reporter' },
      password: 'replacement-password-strong',
      confirmed: true,
    })
    expect(gateway.rotatePassword).toHaveBeenCalledWith(
      connection,
      { engine: 'postgres', username: 'reporter' },
      'replacement-password-strong',
    )
    expect(adopted.password).toBe('replacement-password-strong')
    expect(await repository.findByIdentity(
      'connection-1',
      { engine: 'postgres', username: 'reporter' },
    )).toMatchObject({ status: 'active', connectionLimit: 4, canLogin: true })

    await expect(service.adopt(admin, {
      connectionId: 'connection-1',
      identity: { username: 'postgres' },
      confirmed: true,
    })).rejects.toEqual(new NativeAccountServiceError('PROTECTED_ACCOUNT'))
  })

  it('disables, deletes, and restores a managed account within its recovery window', async () => {
    const { gateway, repository, service } = setup(vi.fn(async () => true))
    const created = await service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'analyst' }, confirmed: true,
    })

    await service.setEnabled(admin, created.account.id, false, true)
    expect(gateway.setAccountEnabled).toHaveBeenCalledWith(
      connection,
      { engine: 'postgres', username: 'analyst' },
      false,
      created.password,
    )
    await service.delete(admin, created.account.id, true)
    expect(gateway.deleteAccount).toHaveBeenCalledWith(
      connection,
      { engine: 'postgres', username: 'analyst' },
    )
    expect(await service.list(admin, 'connection-1')).toContainEqual(expect.objectContaining({
      identity: { engine: 'postgres', username: 'analyst' },
      managed: true,
      managedAccountId: created.account.id,
      managedStatus: 'deleted',
      recoverUntil: '2026-08-14T00:00:00.000Z',
    }))
    await service.restore(admin, created.account.id, true)
    expect(gateway.createAccount).toHaveBeenLastCalledWith(
      connection,
      expect.objectContaining({
        identity: { engine: 'postgres', username: 'analyst' },
        password: created.password,
        canLogin: false,
      }),
    )
    expect(await repository.findById(created.account.id)).toMatchObject({
      status: 'disabled',
      canLogin: false,
    })
    expect(await repository.findById(created.account.id)).not.toHaveProperty('recoverUntil')
  })

  it('rejects destructive lifecycle changes without confirmation and expired recovery', async () => {
    const clock = vi.fn(() => new Date('2026-07-31T00:00:00.000Z'))
    const environment = setup(vi.fn(async () => true))
    const created = await environment.service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'analyst' }, confirmed: true,
    })
    await expect(environment.service.setEnabled(admin, created.account.id, false, false))
      .rejects.toEqual(new NativeAccountServiceError('CONFIRMATION_REQUIRED'))
    await environment.service.delete(admin, created.account.id, true)
    clock.mockReturnValue(new Date('2026-08-15T00:00:00.001Z'))
    const expiredService = new NativeAccountService(
      environment.resolver,
      { postgres: environment.gateway, mysql: environment.gateway },
      environment.repository,
      new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 4))),
      vi.fn(async () => true),
      clock,
      vi.fn(async () => true),
    )
    await expect(expiredService.restore(admin, created.account.id, true))
      .rejects.toEqual(new NativeAccountServiceError('RECOVERY_EXPIRED'))
  })

  it('rotates managed credentials, resets verification state, and hides them from regular managers', async () => {
    const environment = setup(vi.fn(async () => true))
    const created = await environment.service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'analyst' }, confirmed: true,
    })
    await environment.repository.save({
      ...created.account,
      status: 'credential-stale',
      verificationFailures: 1,
      retryVerificationAt: '2026-07-31T00:30:00.000Z',
    })

    const rotated = await environment.service.rotatePassword(admin, created.account.id)
    expect(rotated.password).toHaveLength(32)
    expect(environment.gateway.rotatePassword).toHaveBeenLastCalledWith(
      connection,
      { engine: 'postgres', username: 'analyst' },
      rotated.password,
    )
    expect(await environment.repository.findById(created.account.id)).toMatchObject({
      status: 'active', verificationFailures: 0,
      nextVerificationAt: '2026-07-31T06:00:00.000Z',
    })
    expect(await environment.repository.findById(created.account.id)).not.toHaveProperty('retryVerificationAt')

    const regular = await environment.service.rotatePassword(
      manager,
      created.account.id,
      'another-manual-password',
    )
    expect(regular).not.toHaveProperty('password')
  })

  it('reveals a managed password only to an administrator after one-shot web password verification', async () => {
    const environment = setup(vi.fn(async () => true))
    const created = await environment.service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'analyst' }, confirmed: true,
    })

    await expect(environment.service.revealPassword(admin, created.account.id, 'wrong'))
      .rejects.toEqual(new NativeAccountServiceError('REAUTHENTICATION_FAILED'))
    await expect(environment.service.revealPassword(manager, created.account.id, 'web-password'))
      .rejects.toEqual(new NativeAccountServiceError('FORBIDDEN'))
    await expect(environment.service.revealPassword(admin, created.account.id, 'web-password'))
      .resolves.toBe(created.password)
    expect(environment.reauthenticate).toHaveBeenCalledWith(admin.id, 'web-password')
  })

  it('manually verifies managed credentials and clears stale state immediately', async () => {
    const environment = setup(vi.fn(async () => true))
    const created = await environment.service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'verified' }, confirmed: true,
    })
    await environment.repository.save({
      ...created.account,
      status: 'credential-stale',
      verificationFailures: 1,
      retryVerificationAt: '2026-07-31T00:30:00.000Z',
    })

    await environment.service.verifyNow(admin, created.account.id)

    expect(environment.gateway.verifyCredential).toHaveBeenCalledWith(
      connection,
      'app',
      { engine: 'postgres', username: 'verified' },
      created.password,
    )
    expect(await environment.repository.findById(created.account.id)).toMatchObject({
      status: 'active', verificationFailures: 0,
      lastVerifiedAt: '2026-07-31T00:00:00.000Z',
      nextVerificationAt: '2026-07-31T06:00:00.000Z',
    })
    expect(await environment.repository.findById(created.account.id)).not.toHaveProperty('retryVerificationAt')
  })

  it('audits native account lifecycle and password reveal without recording credentials', async () => {
    const record = vi.fn<SecurityAuditRecorder['record']>(async () => undefined)
    const environment = setup(vi.fn(async () => true), undefined, { record })
    const created = await environment.service.create(admin, {
      connectionId: 'connection-1', identity: { username: 'audited' }, confirmed: true,
    })
    await environment.service.rotatePassword(admin, created.account.id, 'rotated-password-value')
    await environment.service.setEnabled(admin, created.account.id, false, true)
    await expect(environment.service.revealPassword(admin, created.account.id, 'wrong'))
      .rejects.toEqual(new NativeAccountServiceError('REAUTHENTICATION_FAILED'))
    await environment.service.revealPassword(admin, created.account.id, 'web-password')
    await environment.service.delete(admin, created.account.id, true)
    await environment.service.restore(admin, created.account.id, true)

    expect(record.mock.calls.map(([event]) => [event.action, event.status])).toEqual([
      ['native-account-create', 'success'],
      ['native-account-password-rotate', 'success'],
      ['native-account-disable', 'success'],
      ['native-account-password-reveal', 'failed'],
      ['native-account-password-reveal', 'success'],
      ['native-account-delete', 'success'],
      ['native-account-restore', 'success'],
    ])
    expect(JSON.stringify(record.mock.calls)).not.toContain('rotated-password-value')
    expect(JSON.stringify(record.mock.calls)).not.toContain('web-password')
  })
})
