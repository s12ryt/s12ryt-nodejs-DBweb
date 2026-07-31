import { RedisFallbackCircuit } from '../ha/redis-fallback-circuit.js'
import type {
  AuthRepository,
  SessionAuthority,
  StoredSession,
  StoredUser,
  UserLifecycleMutationResult,
} from './auth-types.js'

const SESSION_CACHE_TTL_SECONDS = 60

export interface CachedSession {
  session: StoredSession
  sessionRevision: number
}

export interface SessionCache {
  get(sessionId: string): Promise<CachedSession | undefined>
  set(value: CachedSession, ttlSeconds: number): Promise<void>
  touch(sessionId: string, lastSeenAt: string, ttlSeconds: number): Promise<void>
  delete(sessionId: string): Promise<void>
  invalidateUser(userId: string): Promise<void>
}

export class CachedAuthRepository implements AuthRepository {
  constructor(
    private readonly authority: AuthRepository,
    private readonly cache: SessionCache,
    private readonly circuit: RedisFallbackCircuit,
  ) {}

  createUser(user: StoredUser): Promise<void> {
    return this.authority.createUser(user)
  }

  listUsers(): Promise<StoredUser[]> {
    return this.authority.listUsers()
  }

  findUserByNormalizedUsername(username: string): Promise<StoredUser | undefined> {
    return this.authority.findUserByNormalizedUsername(username)
  }

  findUserById(id: string): Promise<StoredUser | undefined> {
    return this.authority.findUserById(id)
  }

  async updateUserAndRevokeSessions(
    id: string,
    changes: Partial<Pick<StoredUser, 'enabled' | 'passwordChangeRequired' | 'passwordHash' | 'role'>>,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    const result = await this.authority.updateUserAndRevokeSessions(id, changes, protectLastEnabledAdmin)
    if (result === 'updated') await this.invalidateUser(id)
    return result
  }

  async deleteUserAndRevokeSessions(
    id: string,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    const result = await this.authority.deleteUserAndRevokeSessions(id, protectLastEnabledAdmin)
    if (result === 'updated') await this.invalidateUser(id)
    return result
  }

  createSession(session: StoredSession): Promise<void> {
    return this.authority.createSession(session)
  }

  findSessionAuthority(tokenHash: string): Promise<SessionAuthority | undefined> {
    return this.authority.findSessionAuthority(tokenHash)
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined> {
    const authority = await this.authority.findSessionAuthority(tokenHash)
    if (!authority) return undefined
    const cached = await this.circuit.run(
      () => this.cache.get(authority.sessionId),
      async () => undefined,
    )
    if (cached?.sessionRevision === authority.sessionRevision) {
      return structuredClone(cached.session)
    }
    const session = await this.authority.findSessionByTokenHash(tokenHash)
    if (!session) return undefined
    await this.circuit.run(
      async () => this.cache.set({ session, sessionRevision: authority.sessionRevision }, SESSION_CACHE_TTL_SECONDS),
      async () => undefined,
    )
    return session
  }

  async touchSession(id: string, lastSeenAt: string): Promise<void> {
    await this.authority.touchSession(id, lastSeenAt)
    await this.circuit.run(
      () => this.cache.touch(id, lastSeenAt, SESSION_CACHE_TTL_SECONDS),
      async () => undefined,
    )
  }

  async deleteSession(id: string): Promise<void> {
    await this.authority.deleteSession(id)
    await this.circuit.run(() => this.cache.delete(id), async () => undefined)
  }

  private async invalidateUser(userId: string): Promise<void> {
    await this.circuit.run(() => this.cache.invalidateUser(userId), async () => undefined)
  }
}

export class MemorySessionCache implements SessionCache {
  private readonly sessions = new Map<string, CachedSession>()
  failReads = false

  async get(sessionId: string): Promise<CachedSession | undefined> {
    if (this.failReads) throw new Error('REDIS_UNAVAILABLE')
    const cached = this.sessions.get(sessionId)
    return cached ? structuredClone(cached) : undefined
  }

  async set(value: CachedSession): Promise<void> {
    this.sessions.set(value.session.id, structuredClone(value))
  }

  async touch(sessionId: string, lastSeenAt: string): Promise<void> {
    const cached = this.sessions.get(sessionId)
    if (cached) cached.session.lastSeenAt = lastSeenAt
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }

  async invalidateUser(userId: string): Promise<void> {
    for (const [id, cached] of this.sessions) {
      if (cached.session.userId === userId) this.sessions.delete(id)
    }
  }
}
