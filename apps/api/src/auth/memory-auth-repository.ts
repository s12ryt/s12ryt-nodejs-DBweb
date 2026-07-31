import type {
  AuthRepository,
  StoredSession,
  StoredUser,
  UserLifecycleMutationResult,
} from './auth-types.js'

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

  async listUsers(): Promise<StoredUser[]> {
    return [...this.users.values()].map((user) => structuredClone(user))
  }

  async findUserById(id: string): Promise<StoredUser | undefined> {
    const user = this.users.get(id)
    return user ? structuredClone(user) : undefined
  }

  async updateUserAndRevokeSessions(
    id: string,
    changes: Partial<Pick<StoredUser, 'enabled' | 'passwordChangeRequired' | 'passwordHash' | 'role'>>,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    const user = this.users.get(id)
    if (!user) return 'not-found'
    if (
      protectLastEnabledAdmin &&
      user.enabled &&
      user.role === 'admin' &&
      this.enabledAdminCount() <= 1
    ) return 'last-enabled-admin'
    Object.assign(user, changes)
    this.deleteSessionsByUserId(id)
    return 'updated'
  }

  async deleteUserAndRevokeSessions(
    id: string,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    const user = this.users.get(id)
    if (!user) return 'not-found'
    if (
      protectLastEnabledAdmin &&
      user.enabled &&
      user.role === 'admin' &&
      this.enabledAdminCount() <= 1
    ) return 'last-enabled-admin'
    this.deleteSessionsByUserId(id)
    this.users.delete(id)
    this.usersByNormalizedUsername.delete(user.normalizedUsername)
    return 'updated'
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

  private enabledAdminCount(): number {
    return [...this.users.values()].filter((user) => user.enabled && user.role === 'admin').length
  }

  private deleteSessionsByUserId(userId: string): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) this.deleteSession(session.id)
    }
  }
}
