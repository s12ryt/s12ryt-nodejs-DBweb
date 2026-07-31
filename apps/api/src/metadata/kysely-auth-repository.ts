import type {
  AuthRepository,
  StoredSession,
  StoredUser,
} from '../auth/auth-types.js'
import { DuplicateUsernameError } from '../auth/auth-types.js'
import type { MetadataKysely } from './metadata-database.js'

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT' || code === '23505'
}

export class KyselyAuthRepository implements AuthRepository {
  constructor(private readonly database: MetadataKysely) {}

  async createUser(user: StoredUser): Promise<void> {
    try {
      await this.database
        .insertInto('users')
        .values({
          id: user.id,
          username: user.username,
          normalized_username: user.normalizedUsername,
          password_hash: user.passwordHash,
          role: user.role,
          created_at: user.createdAt,
        })
        .execute()
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicateUsernameError()
      throw error
    }
  }

  async findUserByNormalizedUsername(username: string): Promise<StoredUser | undefined> {
    const user = await this.database
      .selectFrom('users')
      .selectAll()
      .where('normalized_username', '=', username)
      .executeTakeFirst()
    return user ? this.mapUser(user) : undefined
  }

  async findUserById(id: string): Promise<StoredUser | undefined> {
    const user = await this.database
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return user ? this.mapUser(user) : undefined
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.database
      .insertInto('sessions')
      .values({
        id: session.id,
        user_id: session.userId,
        token_hash: session.tokenHash,
        created_at: session.createdAt,
        last_seen_at: session.lastSeenAt,
        absolute_expires_at: session.absoluteExpiresAt,
      })
      .execute()
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined> {
    const session = await this.database
      .selectFrom('sessions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst()
    if (!session) return undefined
    return {
      id: session.id,
      userId: session.user_id,
      tokenHash: session.token_hash,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      absoluteExpiresAt: session.absolute_expires_at,
    }
  }

  async touchSession(id: string, lastSeenAt: string): Promise<void> {
    await this.database
      .updateTable('sessions')
      .set({ last_seen_at: lastSeenAt })
      .where('id', '=', id)
      .execute()
  }

  async deleteSession(id: string): Promise<void> {
    await this.database.deleteFrom('sessions').where('id', '=', id).execute()
  }

  private mapUser(user: {
    id: string
    username: string
    normalized_username: string
    password_hash: string
    role: 'admin' | 'user'
    created_at: string
  }): StoredUser {
    return {
      id: user.id,
      username: user.username,
      normalizedUsername: user.normalized_username,
      passwordHash: user.password_hash,
      role: user.role,
      createdAt: user.created_at,
    }
  }
}
