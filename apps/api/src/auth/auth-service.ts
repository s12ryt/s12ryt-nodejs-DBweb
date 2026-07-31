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

type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVALID_SESSION'
  | 'SESSION_EXPIRED'
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

interface LoginResult {
  sessionId: string
  token: string
  user: AuthUser
}

const normalizeUsername = (username: string) => username.trim().toLocaleLowerCase('en-US')
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const toAuthUser = ({ id, username, role }: StoredUser): AuthUser => ({ id, username, role })

export class AuthService {
  private readonly now: () => Date
  private readonly dummyPasswordHash: Promise<string>
  private readonly passwordHashOptions: HashOptions

  constructor(
    private readonly repository: AuthRepository,
    private readonly options: AuthServiceOptions,
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

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.repository.findUserByNormalizedUsername(normalizeUsername(username))
    const passwordHash = user?.passwordHash ?? (await this.dummyPasswordHash)
    const valid = await argon2.verify(passwordHash, password)
    if (!user || !valid) {
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
    if (!user) {
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
}
