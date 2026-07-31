import type {
  AuthRepository,
  StoredSession,
  StoredUser,
  UserLifecycleMutationResult,
} from '../auth/auth-types.js'
import { DuplicateUsernameError } from '../auth/auth-types.js'
import { sql } from 'kysely'
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
          enabled: user.enabled ? 1 : 0,
          password_change_required: user.passwordChangeRequired ? 1 : 0,
          session_revision: user.sessionRevision,
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

  async listUsers(): Promise<StoredUser[]> {
    const users = await this.database.selectFrom('users').selectAll().orderBy('username').execute()
    return users.map((user) => this.mapUser(user))
  }

  async findUserById(id: string): Promise<StoredUser | undefined> {
    const user = await this.database
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return user ? this.mapUser(user) : undefined
  }

  async updateUserAndRevokeSessions(
    id: string,
    changes: Partial<Pick<StoredUser, 'enabled' | 'passwordChangeRequired' | 'passwordHash' | 'role'>>,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    return await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('auth_lifecycle_lock')
        .set({ revision: sql<number>`revision + 1` })
        .where('id', '=', 1)
        .execute()
      const user = await transaction.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
      if (!user) return 'not-found'
      if (
        protectLastEnabledAdmin &&
        user.enabled === 1 &&
        user.role === 'admin' &&
        (await this.enabledAdminCount(transaction)) <= 1
      ) {
        return 'last-enabled-admin'
      }
      await transaction
        .updateTable('users')
        .set({
          ...(changes.enabled === undefined ? {} : { enabled: changes.enabled ? 1 : 0 }),
          ...(changes.passwordChangeRequired === undefined
            ? {}
            : { password_change_required: changes.passwordChangeRequired ? 1 : 0 }),
          ...(changes.passwordHash === undefined ? {} : { password_hash: changes.passwordHash }),
          ...(changes.role === undefined ? {} : { role: changes.role }),
          session_revision: sql<number>`session_revision + 1`,
        })
        .where('id', '=', id)
        .execute()
      await transaction.deleteFrom('sessions').where('user_id', '=', id).execute()
      return 'updated'
    })
  }

  async deleteUserAndRevokeSessions(
    id: string,
    protectLastEnabledAdmin: boolean,
  ): Promise<UserLifecycleMutationResult> {
    return await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('auth_lifecycle_lock')
        .set({ revision: sql<number>`revision + 1` })
        .where('id', '=', 1)
        .execute()
      const user = await transaction.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
      if (!user) return 'not-found'
      if (
        protectLastEnabledAdmin &&
        user.enabled === 1 &&
        user.role === 'admin' &&
        (await this.enabledAdminCount(transaction)) <= 1
      ) {
        return 'last-enabled-admin'
      }
      await transaction.deleteFrom('users').where('id', '=', id).execute()
      return 'updated'
    })
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

  async findSessionAuthority(tokenHash: string) {
    const row = await this.database.selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as session_id',
        'sessions.user_id as user_id',
        'users.session_revision as session_revision',
      ])
      .where('sessions.token_hash', '=', tokenHash)
      .executeTakeFirst()
    return row ? {
      sessionId: row.session_id,
      userId: row.user_id,
      sessionRevision: row.session_revision,
    } : undefined
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
    enabled: number
    password_change_required: number
    session_revision: number
    created_at: string
  }): StoredUser {
    return {
      id: user.id,
      username: user.username,
      normalizedUsername: user.normalized_username,
      passwordHash: user.password_hash,
      role: user.role,
      enabled: user.enabled === 1,
      passwordChangeRequired: user.password_change_required === 1,
      sessionRevision: user.session_revision,
      createdAt: user.created_at,
    }
  }


  private async enabledAdminCount(database: MetadataKysely): Promise<number> {
    const result = await database
      .selectFrom('users')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .where('role', '=', 'admin')
      .where('enabled', '=', 1)
      .executeTakeFirstOrThrow()
    return Number(result.count)
  }
}
