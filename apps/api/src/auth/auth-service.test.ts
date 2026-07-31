import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  EncryptedSecurityAuditRecorder,
  MemorySecurityAuditRepository,
} from '../security/security-audit.js'
import { AuthError, AuthService } from './auth-service.js'
import { MemoryAuthRepository } from './memory-auth-repository.js'

const baseTime = new Date('2026-07-31T12:00:00.000Z')
const testHashOptions = { memoryCost: 8192, timeCost: 1, parallelism: 1 }

function setup() {
  const repository = new MemoryAuthRepository()
  const service = new AuthService(repository, {
    idleTimeoutMs: 30 * 60_000,
    absoluteTimeoutMs: 12 * 60 * 60_000,
    now: () => baseTime,
    passwordHashOptions: testHashOptions,
  })
  return { repository, service }
}

describe('AuthService', () => {
  it('以 Argon2id 保存密碼，並在正確密碼登入後建立不含明文 token 的 session', async () => {
    const { repository, service } = setup()
    const user = await service.createUser({
      username: 'admin',
      password: 'correct horse battery staple',
      role: 'admin',
    })

    expect(repository.getPasswordHash(user.id)).toMatch(/^\$argon2id\$/)

    const login = await service.login('admin', 'correct horse battery staple')

    expect(login.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(login.user).toEqual({
      id: user.id,
      username: 'admin',
      role: 'admin',
      enabled: true,
      passwordChangeRequired: false,
    })
    expect(repository.getStoredSession(login.sessionId)?.tokenHash).not.toBe(login.token)
  })

  it('帳號不存在或密碼錯誤時回傳相同錯誤，避免洩漏帳號是否存在', async () => {
    const { service } = setup()
    await service.createUser({ username: 'admin', password: 'valid password 123', role: 'admin' })

    await expect(service.login('admin', 'wrong password')).rejects.toEqual(
      new AuthError('INVALID_CREDENTIALS'),
    )
    await expect(service.login('missing', 'wrong password')).rejects.toEqual(
      new AuthError('INVALID_CREDENTIALS'),
    )
  })

  it('只為啟用中的本人帳號驗證單次敏感操作密碼', async () => {
    const { service } = setup()
    const admin = await service.createUser({
      username: 'admin', password: 'correct horse battery staple', role: 'admin',
    })
    const user = await service.createUser({
      username: 'operator', password: 'operator password value', role: 'user',
    })
    await expect(service.verifyOwnPassword(admin.id, 'correct horse battery staple')).resolves.toBe(true)
    await expect(service.verifyOwnPassword(admin.id, 'wrong password')).resolves.toBe(false)
    await service.setUserEnabled(admin, user.id, false)
    await expect(service.verifyOwnPassword(user.id, 'operator password value')).resolves.toBe(false)
    await expect(service.verifyOwnPassword('missing-user', 'correct horse battery staple')).resolves.toBe(false)
  })

  it('拒絕重複帳號與少於 12 個字元的密碼', async () => {
    const { service } = setup()

    await expect(
      service.createUser({ username: 'admin', password: 'short', role: 'admin' }),
    ).rejects.toEqual(new AuthError('WEAK_PASSWORD'))

    await service.createUser({ username: 'admin', password: 'valid password 123', role: 'admin' })
    await expect(
      service.createUser({ username: 'ADMIN', password: 'another valid password', role: 'user' }),
    ).rejects.toEqual(new AuthError('USERNAME_TAKEN'))
  })

  it('session 同時受 30 分鐘閒置與 12 小時絕對期限限制', async () => {
    let now = baseTime
    const repository = new MemoryAuthRepository()
    const service = new AuthService(repository, {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      now: () => now,
      passwordHashOptions: testHashOptions,
    })
    await service.createUser({ username: 'admin', password: 'valid password 123', role: 'admin' })
    const login = await service.login('admin', 'valid password 123')

    now = new Date(baseTime.getTime() + 29 * 60_000)
    await expect(service.authenticate(login.token)).resolves.toMatchObject({ username: 'admin' })

    now = new Date(baseTime.getTime() + 60 * 60_000)
    await expect(service.authenticate(login.token)).rejects.toEqual(new AuthError('SESSION_EXPIRED'))

    now = baseTime
    const secondLogin = await service.login('admin', 'valid password 123')
    for (let minute = 29; minute < 12 * 60; minute += 29) {
      now = new Date(baseTime.getTime() + minute * 60_000)
      await service.authenticate(secondLogin.token)
    }
    now = new Date(baseTime.getTime() + 12 * 60 * 60_000)
    await expect(service.authenticate(secondLogin.token)).rejects.toEqual(
      new AuthError('SESSION_EXPIRED'),
    )
  })

  it('登出後立即撤銷 session', async () => {
    const { service } = setup()
    await service.createUser({ username: 'admin', password: 'valid password 123', role: 'admin' })
    const login = await service.login('admin', 'valid password 123')

    await service.logout(login.token)

    await expect(service.authenticate(login.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
  })

  it('停用使用者會撤銷全部 session，停用帳號不能再登入', async () => {
    const { service } = setup()
    const admin = await service.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const operator = await service.createUser({
      username: 'operator',
      password: 'operator password 123',
      role: 'user',
    })
    const first = await service.login('operator', 'operator password 123')
    const second = await service.login('operator', 'operator password 123')

    await service.setUserEnabled(admin, operator.id, false)

    await expect(service.authenticate(first.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
    await expect(service.authenticate(second.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
    await expect(service.login('operator', 'operator password 123')).rejects.toEqual(
      new AuthError('INVALID_CREDENTIALS'),
    )
  })

  it('禁止停用或降權最後一位可用管理員，並撤銷角色變更者的全部 session', async () => {
    const { service } = setup()
    const admin = await service.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const login = await service.login('admin', 'valid password 123')

    await expect(service.setUserEnabled(admin, admin.id, false)).rejects.toEqual(
      new AuthError('LAST_ENABLED_ADMIN'),
    )
    await expect(service.setUserRole(admin, admin.id, 'user')).rejects.toEqual(
      new AuthError('LAST_ENABLED_ADMIN'),
    )

    const backup = await service.createUser({
      username: 'backup-admin',
      password: 'backup password 123',
      role: 'admin',
    })
    await service.setUserRole(backup, admin.id, 'user')

    await expect(service.authenticate(login.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
    await expect(service.listUsers(backup)).resolves.toContainEqual(
      expect.objectContaining({ id: admin.id, role: 'user', enabled: true }),
    )
  })

  it('管理員重設密碼後只回傳當次臨時密碼，使用者必須先改密碼才能解除旗標', async () => {
    const { service } = setup()
    const admin = await service.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const operator = await service.createUser({
      username: 'operator',
      password: 'operator password 123',
      role: 'user',
    })
    const oldSession = await service.login('operator', 'operator password 123')

    const reset = await service.resetUserPassword(admin, operator.id)

    expect(reset.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{20}$/)
    await expect(service.authenticate(oldSession.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
    const temporaryLogin = await service.login('operator', reset.temporaryPassword)
    expect(temporaryLogin.user.passwordChangeRequired).toBe(true)

    await service.changeOwnPassword(temporaryLogin.user, reset.temporaryPassword, 'new password 456')

    await expect(service.authenticate(temporaryLogin.token)).rejects.toEqual(
      new AuthError('INVALID_SESSION'),
    )
    const changedLogin = await service.login('operator', 'new password 456')
    expect(changedLogin.user.passwordChangeRequired).toBe(false)
  })

  it('永久刪除使用者會清除 session，且不能刪除最後一位可用管理員', async () => {
    const { service } = setup()
    const admin = await service.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const operator = await service.createUser({
      username: 'operator',
      password: 'operator password 123',
      role: 'user',
    })
    const login = await service.login('operator', 'operator password 123')

    await expect(service.deleteUser(admin, admin.id)).rejects.toEqual(
      new AuthError('LAST_ENABLED_ADMIN'),
    )
    await service.deleteUser(admin, operator.id)

    await expect(service.authenticate(login.token)).rejects.toEqual(new AuthError('INVALID_SESSION'))
    await expect(service.login('operator', 'operator password 123')).rejects.toEqual(
      new AuthError('INVALID_CREDENTIALS'),
    )
  })

  it('生命週期成功與最後管理員保護失敗皆寫安全稽核且不含密碼', async () => {
    const repository = new MemoryAuthRepository()
    const auditRepository = new MemorySecurityAuditRepository()
    const service = new AuthService(
      repository,
      {
        idleTimeoutMs: 30 * 60_000,
        absoluteTimeoutMs: 12 * 60 * 60_000,
        now: () => baseTime,
        passwordHashOptions: testHashOptions,
      },
      new EncryptedSecurityAuditRecorder(
        auditRepository,
        new EnvelopeEncryption(Buffer.alloc(32, 61)),
        () => baseTime,
      ),
    )
    const admin = await service.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const created = await service.createManagedUser(admin, { username: 'operator', role: 'user' })
    await service.resetUserPassword(admin, created.user.id, 'temporary password 123')
    await expect(service.setUserRole(admin, admin.id, 'user')).rejects.toEqual(
      new AuthError('LAST_ENABLED_ADMIN'),
    )

    const events = await auditRepository.list()
    expect(events.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: 'web-user-create', status: 'success' },
      { action: 'password-reset', status: 'success' },
      { action: 'web-user-role-change', status: 'failed' },
    ])
    expect(JSON.stringify(events)).not.toContain('temporary password 123')
  })
})
