import { describe, expect, it } from 'vitest'

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
    expect(login.user).toEqual({ id: user.id, username: 'admin', role: 'admin' })
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
})
