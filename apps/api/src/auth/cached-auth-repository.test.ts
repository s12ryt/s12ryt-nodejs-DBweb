import { describe, expect, it, vi } from 'vitest'

import { RedisFallbackCircuit } from '../ha/redis-fallback-circuit.js'
import type { StoredSession, StoredUser } from './auth-types.js'
import { CachedAuthRepository, MemorySessionCache } from './cached-auth-repository.js'
import { MemoryAuthRepository } from './memory-auth-repository.js'

const user: StoredUser = {
  id: 'user-1',
  username: 'operator',
  normalizedUsername: 'operator',
  passwordHash: 'hash',
  role: 'user',
  enabled: true,
  passwordChangeRequired: false,
  sessionRevision: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
}

const session: StoredSession = {
  id: 'session-1',
  userId: user.id,
  tokenHash: 'a'.repeat(64),
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-01T00:00:00.000Z',
  absoluteExpiresAt: '2026-08-01T12:00:00.000Z',
}

async function setup() {
  const authority = new MemoryAuthRepository()
  await authority.createUser(user)
  await authority.createSession(session)
  const cache = new MemorySessionCache()
  const repository = new CachedAuthRepository(authority, cache, new RedisFallbackCircuit())
  return { authority, cache, repository }
}

describe('CachedAuthRepository', () => {
  it('每次先讀PG revision，revision相同時從Redis session cache命中', async () => {
    const { authority, repository } = await setup()
    const findFull = vi.spyOn(authority, 'findSessionByTokenHash')
    const findAuthority = vi.spyOn(authority, 'findSessionAuthority')

    await expect(repository.findSessionByTokenHash(session.tokenHash)).resolves.toEqual(session)
    await expect(repository.findSessionByTokenHash(session.tokenHash)).resolves.toEqual(session)

    expect(findAuthority).toHaveBeenCalledTimes(2)
    expect(findFull).toHaveBeenCalledTimes(1)
  })

  it('使用者revision變更並撤銷session後，下一請求不接受舊cache', async () => {
    const { authority, repository } = await setup()
    await repository.findSessionByTokenHash(session.tokenHash)

    await authority.updateUserAndRevokeSessions(user.id, { enabled: false }, false)

    await expect(repository.findSessionByTokenHash(session.tokenHash)).resolves.toBeUndefined()
  })

  it('touch同步cache，Redis失敗則自動回PG完整session', async () => {
    const { authority, cache, repository } = await setup()
    await repository.findSessionByTokenHash(session.tokenHash)
    await repository.touchSession(session.id, '2026-08-01T00:01:00.000Z')
    expect((await cache.get(session.id))?.session.lastSeenAt).toBe('2026-08-01T00:01:00.000Z')

    cache.failReads = true
    const findFull = vi.spyOn(authority, 'findSessionByTokenHash')
    await expect(repository.findSessionByTokenHash(session.tokenHash)).resolves.toMatchObject({
      id: session.id,
      lastSeenAt: '2026-08-01T00:01:00.000Z',
    })
    expect(findFull).toHaveBeenCalledTimes(1)
  })
})
