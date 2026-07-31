import type { CachedSession, SessionCache } from '../auth/cached-auth-repository.js'

const SESSION_KEY_PREFIX = 'dbweb:session:v1:'
const USER_SESSIONS_KEY_PREFIX = 'dbweb:user-sessions:v1:'
const INVALIDATION_CHANNEL = 'dbweb:session:invalidate:v1'

export interface RedisSessionClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  sAdd(key: string, member: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  sMembers(key: string): Promise<string[]>
  del(keys: string | string[]): Promise<unknown>
  publish(channel: string, message: string): Promise<unknown>
}

export class RedisSessionCache implements SessionCache {
  constructor(private readonly redis: RedisSessionClient) {}

  async get(sessionId: string): Promise<CachedSession | undefined> {
    const key = sessionKey(sessionId)
    const value = await this.redis.get(key)
    if (value === null) return undefined
    const parsed = parseCachedSession(value)
    if (!parsed || parsed.session.id !== sessionId) {
      await this.redis.del(key)
      return undefined
    }
    return parsed
  }

  async set(value: CachedSession, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds)
    const key = sessionKey(value.session.id)
    const userKey = userSessionsKey(value.session.userId)
    await this.redis.set(key, JSON.stringify(value))
    await this.redis.expire(key, ttlSeconds)
    await this.redis.sAdd(userKey, value.session.id)
    await this.redis.expire(userKey, ttlSeconds * 2)
  }

  async touch(sessionId: string, lastSeenAt: string, ttlSeconds: number): Promise<void> {
    const cached = await this.get(sessionId)
    if (!cached) return
    cached.session.lastSeenAt = lastSeenAt
    await this.set(cached, ttlSeconds)
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId))
  }

  async invalidateUser(userId: string): Promise<void> {
    const indexKey = userSessionsKey(userId)
    const sessionIds = await this.redis.sMembers(indexKey)
    const keys = sessionIds.map(sessionKey)
    await this.redis.del([...keys, indexKey])
    await this.redis.publish(INVALIDATION_CHANNEL, userId)
  }
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${safeKeyPart(sessionId)}`
}

function userSessionsKey(userId: string): string {
  return `${USER_SESSIONS_KEY_PREFIX}${safeKeyPart(userId)}`
}

function safeKeyPart(value: string): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('INVALID_SESSION_CACHE_KEY')
  }
  return value
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new Error('INVALID_SESSION_CACHE_TTL')
  }
}

function parseCachedSession(value: string): CachedSession | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['session', 'sessionRevision'])) return undefined
  if (!Number.isSafeInteger(parsed.sessionRevision) || Number(parsed.sessionRevision) < 0) return undefined
  const session = parsed.session
  if (!isRecord(session) || !hasOnlyKeys(session, [
    'id', 'userId', 'tokenHash', 'createdAt', 'lastSeenAt', 'absoluteExpiresAt',
  ])) return undefined
  if (
    !isString(session.id)
    || !isString(session.userId)
    || typeof session.tokenHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(session.tokenHash)
    || !isIsoDate(session.createdAt)
    || !isIsoDate(session.lastSeenAt)
    || !isIsoDate(session.absoluteExpiresAt)
  ) return undefined
  return {
    sessionRevision: Number(parsed.sessionRevision),
    session: {
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
