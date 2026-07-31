export type UserRole = 'admin' | 'user'

export interface AuthUser {
  id: string
  username: string
  role: UserRole
  enabled: boolean
  passwordChangeRequired: boolean
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
  listUsers(): Promise<StoredUser[]>
  findUserByNormalizedUsername(username: string): Promise<StoredUser | undefined>
  findUserById(id: string): Promise<StoredUser | undefined>
  updateUserAndRevokeSessions(
    id: string,
    changes: Partial<Pick<StoredUser, 'enabled' | 'passwordChangeRequired' | 'passwordHash' | 'role'>>,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult>
  deleteUserAndRevokeSessions(
    id: string,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult>
  createSession(session: StoredSession): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined>
  touchSession(id: string, lastSeenAt: string): Promise<void>
  deleteSession(id: string): Promise<void>
}

export type UserLifecycleMutationResult = 'updated' | 'not-found' | 'last-enabled-admin'

export class DuplicateUsernameError extends Error {
  constructor() {
    super('DUPLICATE_USERNAME')
    this.name = 'DuplicateUsernameError'
  }
}
