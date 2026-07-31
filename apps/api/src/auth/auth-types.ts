export type UserRole = 'admin' | 'user'

export interface AuthUser {
  id: string
  username: string
  role: UserRole
}

export interface StoredUser extends AuthUser {
  normalizedUsername: string
  passwordHash: string
  createdAt: string
}

export interface StoredSession {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string
  absoluteExpiresAt: string
}

export interface AuthRepository {
  createUser(user: StoredUser): Promise<void>
  findUserByNormalizedUsername(username: string): Promise<StoredUser | undefined>
  findUserById(id: string): Promise<StoredUser | undefined>
  createSession(session: StoredSession): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined>
  touchSession(id: string, lastSeenAt: string): Promise<void>
  deleteSession(id: string): Promise<void>
}

export class DuplicateUsernameError extends Error {
  constructor() {
    super('DUPLICATE_USERNAME')
    this.name = 'DuplicateUsernameError'
  }
}
