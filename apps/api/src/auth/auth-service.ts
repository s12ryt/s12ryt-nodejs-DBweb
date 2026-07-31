import { createHash, randomBytes, randomUUID } from 'node:crypto'

import argon2, { type HashOptions } from 'argon2'

import type {
  AuthRepository,
  AuthUser,
  StoredSession,
  StoredUser,
  UserRole,
} from './auth-types.js'
import { DuplicateUsernameError } from './auth-types.js'
import type { SecurityAuditAction, SecurityAuditRecorder } from '../security/security-audit.js'

type AuthErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_SESSION'
  | 'LAST_ENABLED_ADMIN'
  | 'SESSION_EXPIRED'
  | 'USER_NOT_FOUND'
  | 'USERNAME_TAKEN'
  | 'WEAK_PASSWORD'

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code)
    this.name = 'AuthError'
  }
}

interface AuthServiceOptions {
  idleTimeoutMs: number
  absoluteTimeoutMs: number
  now?: () => Date
  passwordHashOptions?: HashOptions
}

interface CreateUserInput {
  username: string
  password: string
  role: UserRole
}

interface CreateManagedUserInput {
  username: string
  password?: string
  role: UserRole
}

interface LoginResult {
  sessionId: string
  token: string
  user: AuthUser
}

const normalizeUsername = (username: string) => username.trim().toLocaleLowerCase('en-US')
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const toAuthUser = ({
  id,
  username,
  role,
  enabled,
  passwordChangeRequired,
}: StoredUser): AuthUser => ({ id, username, role, enabled, passwordChangeRequired })

export class AuthService {
  private readonly now: () => Date
  private readonly dummyPasswordHash: Promise<string>
  private readonly passwordHashOptions: HashOptions

  constructor(
    private readonly repository: AuthRepository,
    private readonly options: AuthServiceOptions,
    private readonly audit?: SecurityAuditRecorder,
  ) {
    this.now = options.now ?? (() => new Date())
    this.passwordHashOptions = { ...options.passwordHashOptions, type: argon2.argon2id }
    this.dummyPasswordHash = argon2.hash(
      'dbweb-invalid-credential-sentinel',
      this.passwordHashOptions,
    )
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    if (input.password.length < 12) {
      throw new AuthError('WEAK_PASSWORD')
    }

    const normalizedUsername = normalizeUsername(input.username)
    if (await this.repository.findUserByNormalizedUsername(normalizedUsername)) {
      throw new AuthError('USERNAME_TAKEN')
    }

    const now = this.now().toISOString()
    const user: StoredUser = {
      id: randomUUID(),
      username: input.username.trim(),
      normalizedUsername,
      passwordHash: await argon2.hash(input.password, this.passwordHashOptions),
      role: input.role,
      enabled: true,
      passwordChangeRequired: false,
      createdAt: now,
    }
    try {
      await this.repository.createUser(user)
    } catch (error) {
      if (error instanceof DuplicateUsernameError) {
        throw new AuthError('USERNAME_TAKEN')
      }
      throw error
    }
    return toAuthUser(user)
  }

  async createManagedUser(
    actor: AuthUser,
    input: CreateManagedUserInput,
  ): Promise<{ user: AuthUser; temporaryPassword: string }> {
    this.requireAdmin(actor)
    const temporaryPassword = input.password ?? randomBytes(15).toString('base64url')
    this.assertStrongPassword(temporaryPassword)
    const created = await this.createUser({
      username: input.username,
      password: temporaryPassword,
      role: input.role,
    })
    const user = await this.updateUser(created.id, { passwordChangeRequired: true }, false)
    await this.recordAudit({
      actorId: actor.id,
      targetUserId: user.id,
      action: 'web-user-create',
      status: 'success',
      details: { role: user.role, enabled: user.enabled },
    })
    return { user, temporaryPassword }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.repository.findUserByNormalizedUsername(normalizeUsername(username))
    const passwordHash = user?.passwordHash ?? (await this.dummyPasswordHash)
    const valid = await argon2.verify(passwordHash, password)
    if (!user || !valid || !user.enabled) {
      throw new AuthError('INVALID_CREDENTIALS')
    }

    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const session: StoredSession = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + this.options.absoluteTimeoutMs).toISOString(),
    }
    await this.repository.createSession(session)
    return { sessionId: session.id, token, user: toAuthUser(user) }
  }

  async verifyOwnPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.repository.findUserById(userId)
    if (!user?.enabled) return false
    return await argon2.verify(user.passwordHash, password)
  }

  async authenticate(token: string): Promise<AuthUser> {
    const session = await this.repository.findSessionByTokenHash(hashToken(token))
    if (!session) {
      throw new AuthError('INVALID_SESSION')
    }

    const now = this.now()
    const idleExpiresAt = new Date(session.lastSeenAt).getTime() + this.options.idleTimeoutMs
    if (now.getTime() >= idleExpiresAt || now.getTime() >= new Date(session.absoluteExpiresAt).getTime()) {
      await this.repository.deleteSession(session.id)
      throw new AuthError('SESSION_EXPIRED')
    }

    const user = await this.repository.findUserById(session.userId)
    if (!user || !user.enabled) {
      await this.repository.deleteSession(session.id)
      throw new AuthError('INVALID_SESSION')
    }

    await this.repository.touchSession(session.id, now.toISOString())
    return toAuthUser(user)
  }

  async logout(token: string): Promise<void> {
    const session = await this.repository.findSessionByTokenHash(hashToken(token))
    if (session) {
      await this.repository.deleteSession(session.id)
    }
  }

  async listUsers(actor: AuthUser): Promise<AuthUser[]> {
    this.requireAdmin(actor)
    return (await this.repository.listUsers()).map(toAuthUser)
  }

  async setUserEnabled(actor: AuthUser, userId: string, enabled: boolean): Promise<AuthUser> {
    this.requireAdmin(actor)
    return await this.auditedUserMutation(
      actor.id,
      userId,
      enabled ? 'web-user-enable' : 'web-user-disable',
      { enabled },
      async () => await this.updateUser(userId, { enabled }, !enabled),
    )
  }

  async setUserRole(actor: AuthUser, userId: string, role: UserRole): Promise<AuthUser> {
    this.requireAdmin(actor)
    return await this.auditedUserMutation(
      actor.id,
      userId,
      'web-user-role-change',
      { role },
      async () => await this.updateUser(userId, { role }, role !== 'admin'),
    )
  }

  async resetUserPassword(
    actor: AuthUser,
    userId: string,
    password?: string,
  ): Promise<{ user: AuthUser; temporaryPassword: string }> {
    this.requireAdmin(actor)
    const temporaryPassword = password ?? randomBytes(15).toString('base64url')
    this.assertStrongPassword(temporaryPassword)
    const user = await this.updateUser(userId, {
      passwordHash: await argon2.hash(temporaryPassword, this.passwordHashOptions),
      passwordChangeRequired: true,
    }, false)
    await this.recordAudit({
      actorId: actor.id,
      targetUserId: userId,
      action: 'password-reset',
      status: 'success',
    })
    return { user, temporaryPassword }
  }

  async changeOwnPassword(
    actor: AuthUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthUser> {
    this.assertStrongPassword(newPassword)
    const stored = await this.repository.findUserById(actor.id)
    if (!stored || !stored.enabled || !(await argon2.verify(stored.passwordHash, currentPassword))) {
      throw new AuthError('INVALID_CREDENTIALS')
    }
    const user = await this.updateUser(actor.id, {
      passwordHash: await argon2.hash(newPassword, this.passwordHashOptions),
      passwordChangeRequired: false,
    }, false)
    await this.recordAudit({
      actorId: actor.id,
      targetUserId: actor.id,
      action: 'password-change',
      status: 'success',
    })
    return user
  }

  async deleteUser(actor: AuthUser, userId: string): Promise<void> {
    this.requireAdmin(actor)
    const target = await this.repository.findUserById(userId)
    if (!target) throw new AuthError('USER_NOT_FOUND')
    try {
      const result = await this.repository.deleteUserAndRevokeSessions(
        userId,
        target.enabled && target.role === 'admin',
      )
      this.assertMutationResult(result)
      await this.recordAudit({
        actorId: actor.id,
        targetUserId: userId,
        action: 'web-user-delete',
        status: 'success',
      })
    } catch (error) {
      await this.recordFailedAudit(actor.id, userId, 'web-user-delete', error)
      throw error
    }
  }

  private async updateUser(
    userId: string,
    changes: Partial<Pick<StoredUser, 'enabled' | 'passwordChangeRequired' | 'passwordHash' | 'role'>>,
    protectLastEnabledAdmin: boolean,
  ): Promise<AuthUser> {
    const result = await this.repository.updateUserAndRevokeSessions(
      userId,
      changes,
      protectLastEnabledAdmin,
    )
    this.assertMutationResult(result)
    const user = await this.repository.findUserById(userId)
    if (!user) throw new AuthError('USER_NOT_FOUND')
    return toAuthUser(user)
  }

  private assertMutationResult(result: 'updated' | 'not-found' | 'last-enabled-admin'): void {
    if (result === 'not-found') throw new AuthError('USER_NOT_FOUND')
    if (result === 'last-enabled-admin') throw new AuthError('LAST_ENABLED_ADMIN')
  }

  private assertStrongPassword(password: string): void {
    if (password.length < 12) throw new AuthError('WEAK_PASSWORD')
  }

  private requireAdmin(actor: AuthUser): void {
    if (actor.role !== 'admin') throw new AuthError('FORBIDDEN')
  }

  private async auditedUserMutation(
    actorId: string,
    targetUserId: string,
    action: SecurityAuditAction,
    details: { enabled?: boolean; role?: UserRole },
    operation: () => Promise<AuthUser>,
  ): Promise<AuthUser> {
    try {
      const user = await operation()
      await this.recordAudit({
        actorId,
        targetUserId,
        action,
        status: 'success',
        details,
      })
      return user
    } catch (error) {
      await this.recordFailedAudit(actorId, targetUserId, action, error)
      throw error
    }
  }

  private async recordFailedAudit(
    actorId: string,
    targetUserId: string,
    action: SecurityAuditAction,
    error: unknown,
  ): Promise<void> {
    await this.recordAudit({
      actorId,
      targetUserId,
      action,
      status: 'failed',
      ...(error instanceof AuthError ? { errorCode: error.code } : {}),
    })
  }

  private async recordAudit(
    event: Parameters<SecurityAuditRecorder['record']>[0],
  ): Promise<void> {
    await this.audit?.record(event)
  }
}
