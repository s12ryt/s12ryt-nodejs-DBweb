import { describe, expect, it, vi } from 'vitest'

import type { CachedSession } from '../auth/cached-auth-repository.js'
import { RedisSessionCache } from './redis-session-cache.js'

const cached: CachedSession = {
  sessionRevision: 3,
  session: {
    id: 'session-1',
    userId: 'user-1',
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:01:00.000Z',
    absoluteExpiresAt: '2026-08-01T12:00:00.000Z',
  },
}

class FakeRedis {
  readonly strings = new Map<string, string>()
  readonly sets = new Map<string, Set<string>>()
  readonly published: Array<[string, string]> = []

  async get(key: string) { return this.strings.get(key) ?? null }
  async set(key: string, value: string) { this.strings.set(key, value); return 'OK' }
  async sAdd(key: string, member: string) {
    const set = this.sets.get(key) ?? new Set<string>()
    set.add(member)
    this.sets.set(key, set)
    return 1
  }
  async expire() { return 1 }
  async sMembers(key: string) { return [...(this.sets.get(key) ?? [])] }
  async del(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.strings.delete(key)
      this.sets.delete(key)
    }
    return 1
  }
  async publish(channel: string, message: string) {
    this.published.push([channel, message])
    return 1
  }
}

describe('RedisSessionCache', () => {
  it('以固定namespace與TTL保存session hash，並同步touch', async () => {
    const redis = new FakeRedis()
    const cache = new RedisSessionCache(redis)

    await cache.set(cached, 60)
    await expect(cache.get(cached.session.id)).resolves.toEqual(cached)
    await cache.touch(cached.session.id, '2026-08-01T00:02:00.000Z', 60)
    expect((await cache.get(cached.session.id))?.session.lastSeenAt)
      .toBe('2026-08-01T00:02:00.000Z')
    expect([...redis.strings.keys()]).toEqual(['dbweb:session:v1:session-1'])
  })

  it('撤銷user時刪除全部session keys並發布固定失效channel', async () => {
    const redis = new FakeRedis()
    const cache = new RedisSessionCache(redis)
    await cache.set(cached, 60)
    await cache.set({
      ...cached,
      session: { ...cached.session, id: 'session-2' },
    }, 60)

    await cache.invalidateUser('user-1')

    await expect(cache.get('session-1')).resolves.toBeUndefined()
    await expect(cache.get('session-2')).resolves.toBeUndefined()
    expect(redis.published).toEqual([['dbweb:session:invalidate:v1', 'user-1']])
  })

  it('malformed或非預期cache payload視為miss並清除', async () => {
    const redis = new FakeRedis()
    redis.strings.set('dbweb:session:v1:session-1', '{"password":"secret"}')
    const del = vi.spyOn(redis, 'del')
    const cache = new RedisSessionCache(redis)

    await expect(cache.get('session-1')).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledWith('dbweb:session:v1:session-1')
  })
})
