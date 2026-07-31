import type { AuthRepository, StoredSession, StoredUser } from './auth-types.js'

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, StoredUser>()
  private readonly usersByNormalizedUsername = new Map<string, string>()
  private readonly sessions = new Map<string, StoredSession>()
  private readonly sessionIdsByTokenHash = new Map<string, string>()

  async createUser(user: StoredUser): Promise<void> {
    this.users.set(user.id, structuredClone(user))
    this.usersByNormalizedUsername.set(user.normalizedUsername, user.id)
  }

  async findUserByNormalizedUsername(username: string): Promise<StoredUser | undefined> {
    const id = this.usersByNormalizedUsername.get(username)
    const user = id ? this.users.get(id) : undefined
    return user ? structuredClone(user) : undefined
  }

  async findUserById(id: string): Promise<StoredUser | undefined> {
    const user = this.users.get(id)
    return user ? structuredClone(user) : undefined
  }

  async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session))
    this.sessionIdsByTokenHash.set(session.tokenHash, session.id)
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined> {
    const id = this.sessionIdsByTokenHash.get(tokenHash)
    const session = id ? this.sessions.get(id) : undefined
    return session ? structuredClone(session) : undefined
  }

  async touchSession(id: string, lastSeenAt: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session) {
      session.lastSeenAt = lastSeenAt
    }
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session) {
      this.sessionIdsByTokenHash.delete(session.tokenHash)
      this.sessions.delete(id)
    }
  }

  getPasswordHash(userId: string): string | undefined {
    return this.users.get(userId)?.passwordHash
  }

  getStoredSession(id: string): StoredSession | undefined {
    const session = this.sessions.get(id)
    return session ? structuredClone(session) : undefined
  }
}
