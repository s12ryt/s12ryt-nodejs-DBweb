import { randomUUID } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import type { SecurityAuditAction, SecurityAuditRecorder } from '../security/security-audit.js'
import type { NativeAccountCredentialVault } from './native-account-credential.js'
import {
  identityKey,
  isProtectedNativeAccount,
  normalizeNativeAccountIdentity,
  type NativeAccountIdentity,
} from './native-account-policy.js'

export interface ActualNativeAccount {
  identity: NativeAccountIdentity
  canLogin: boolean
  passwordExpired: boolean
  connectionLimit: number
  systemAccount: boolean
}

export interface CreateNativeAccountRequest {
  identity: NativeAccountIdentity
  password: string
  canLogin: boolean
  connectionLimit: number
}

export interface NativeAccountGateway {
  listAccounts(connection: ResolvedConnection): Promise<ActualNativeAccount[]>
  createAccount(connection: ResolvedConnection, request: CreateNativeAccountRequest): Promise<void>
  rotatePassword(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void>
  setAccountEnabled(
    connection: ResolvedConnection,
    identity: NativeAccountIdentity,
    enabled: boolean,
    password: string,
  ): Promise<void>
  deleteAccount(connection: ResolvedConnection, identity: NativeAccountIdentity): Promise<void>
  verifyCredential(
    connection: ResolvedConnection,
    database: string,
    identity: NativeAccountIdentity,
    password: string,
  ): Promise<void>
}

export interface StoredNativeAccount {
  id: string
  connectionId: string
  identity: NativeAccountIdentity
  encryptedPassword: string
  verificationDatabase: string
  verificationIntervalMs: number
  canLogin: boolean
  connectionLimit: number
  status: 'active' | 'disabled' | 'credential-stale' | 'deleted'
  verificationFailures: number
  nextVerificationAt: string
  lastVerifiedAt?: string
  retryVerificationAt?: string
  deletedAt?: string
  recoverUntil?: string
  createdAt: string
  updatedAt: string
}

export interface NativeAccountRepository {
  findById(id: string): Promise<StoredNativeAccount | undefined>
  findByIdentity(
    connectionId: string,
    identity: NativeAccountIdentity,
  ): Promise<StoredNativeAccount | undefined>
  listByConnection(connectionId: string): Promise<StoredNativeAccount[]>
  listDue(now: string): Promise<StoredNativeAccount[]>
  deleteExpiredRecovery(now: string): Promise<number>
  save(account: StoredNativeAccount): Promise<void>
}

export interface PublicNativeAccount extends ActualNativeAccount {
  managed: boolean
  managedAccountId?: string
  protected: boolean
  protectionReason?: 'connection-account' | 'system-account'
  managedStatus?: StoredNativeAccount['status']
  recoverUntil?: string
}

export interface CreateNativeAccountInput {
  connectionId: string
  identity: { username: string; host?: string }
  password?: string
  connectionLimit?: number
  verificationDatabase?: string
  verificationIntervalMs?: number
  confirmed: boolean
}

export interface CreatedNativeAccount {
  account: StoredNativeAccount
  password?: string
}

export type NativeAccountAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  connectionId: string,
) => Promise<boolean>

export class NativeAccountServiceError extends Error {
  constructor(readonly code:
    | 'ACCOUNT_NOT_FOUND'
    | 'CONFIRMATION_REQUIRED'
    | 'FORBIDDEN'
    | 'INVALID_ACCOUNT'
    | 'PROTECTED_ACCOUNT'
    | 'REAUTHENTICATION_FAILED'
    | 'RECOVERY_EXPIRED') {
    super(code)
    this.name = 'NativeAccountServiceError'
  }
}

const DEFAULT_VERIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000
const MIN_VERIFICATION_INTERVAL_MS = 60 * 60 * 1000
const MAX_VERIFICATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const RECOVERY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export class NativeAccountService {
  constructor(
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, NativeAccountGateway>,
    private readonly repository: NativeAccountRepository,
    private readonly credentials: NativeAccountCredentialVault,
    private readonly authorize: NativeAccountAuthorizer = async (actor) => actor.role === 'admin',
    private readonly now: () => Date = () => new Date(),
    private readonly reauthenticate: (actorId: string, password: string) => Promise<boolean> = async () => false,
    private readonly securityAudit?: SecurityAuditRecorder,
  ) {}

  async list(actor: Pick<AuthUser, 'id' | 'role'>, connectionId: string): Promise<PublicNativeAccount[]> {
    await this.requireAuthorized(actor, connectionId)
    const connection = await this.connections.resolveConnection(connectionId)
    const [actualAccounts, managedAccounts] = await Promise.all([
      this.gateways[connection.engine].listAccounts(connection),
      this.repository.listByConnection(connectionId),
    ])
    const managedByIdentity = new Map(
      managedAccounts.map((account) => [identityKey(account.identity), account]),
    )
    const actualIdentityKeys = new Set(actualAccounts.map((account) => identityKey(account.identity)))
    const visible = actualAccounts.map((account) => {
      const managed = managedByIdentity.get(identityKey(account.identity))
      const protection = isProtectedNativeAccount(account, connection)
      return {
        ...account,
        managed: Boolean(managed),
        ...(managed ? { managedAccountId: managed.id } : {}),
        ...(managed ? { managedStatus: managed.status } : {}),
        ...(managed?.recoverUntil ? { recoverUntil: managed.recoverUntil } : {}),
        protected: protection.protected,
        ...(protection.protected ? { protectionReason: protection.reason } : {}),
      }
    })
    for (const managed of managedAccounts) {
      if (managed.status !== 'deleted' || actualIdentityKeys.has(identityKey(managed.identity))) continue
      const protection = isProtectedNativeAccount(
        { identity: managed.identity, systemAccount: false },
        connection,
      )
      visible.push({
        identity: managed.identity,
        canLogin: managed.canLogin,
        passwordExpired: false,
        connectionLimit: managed.connectionLimit,
        systemAccount: false,
        managed: true,
        managedAccountId: managed.id,
        managedStatus: managed.status,
        ...(managed.recoverUntil ? { recoverUntil: managed.recoverUntil } : {}),
        protected: protection.protected,
        ...(protection.protected ? { protectionReason: protection.reason } : {}),
      })
    }
    return visible
  }

  async create(
    actor: Pick<AuthUser, 'id' | 'role'>,
    input: CreateNativeAccountInput,
  ): Promise<CreatedNativeAccount> {
    await this.requireAuthorized(actor, input.connectionId)
    if (!input.confirmed) throw new NativeAccountServiceError('CONFIRMATION_REQUIRED')
    const connection = await this.connections.resolveConnection(input.connectionId)
    const identity = normalizeNativeAccountIdentity(connection.engine, input.identity)
    const verificationIntervalMs = input.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS
    if (
      verificationIntervalMs < MIN_VERIFICATION_INTERVAL_MS ||
      verificationIntervalMs > MAX_VERIFICATION_INTERVAL_MS ||
      !Number.isInteger(input.connectionLimit ?? -1) ||
      (input.connectionLimit ?? -1) < -1
    ) {
      throw new NativeAccountServiceError('INVALID_ACCOUNT')
    }

    const id = randomUUID()
    const sealed = this.credentials.seal(id, input.password)
    await this.gateways[connection.engine].createAccount(connection, {
      identity,
      password: sealed.password,
      canLogin: true,
      connectionLimit: input.connectionLimit ?? -1,
    })
    const timestamp = this.now().toISOString()
    const account: StoredNativeAccount = {
      id,
      connectionId: input.connectionId,
      identity,
      encryptedPassword: sealed.encryptedPassword,
      verificationDatabase: input.verificationDatabase?.trim() || connection.database,
      verificationIntervalMs,
      canLogin: true,
      connectionLimit: input.connectionLimit ?? -1,
      status: 'active',
      verificationFailures: 0,
      nextVerificationAt: new Date(this.now().getTime() + verificationIntervalMs).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.repository.save(account)
    await this.audit(actor, account, 'native-account-create', 'success')
    return {
      account,
      ...(actor.role === 'admin' ? { password: sealed.password } : {}),
    }
  }

  async adopt(
    actor: Pick<AuthUser, 'id' | 'role'>,
    input: CreateNativeAccountInput,
  ): Promise<CreatedNativeAccount> {
    await this.requireAuthorized(actor, input.connectionId)
    if (!input.confirmed) throw new NativeAccountServiceError('CONFIRMATION_REQUIRED')
    const connection = await this.connections.resolveConnection(input.connectionId)
    const identity = normalizeNativeAccountIdentity(connection.engine, input.identity)
    const actual = (await this.gateways[connection.engine].listAccounts(connection))
      .find((account) => identityKey(account.identity) === identityKey(identity))
    if (!actual) throw new NativeAccountServiceError('ACCOUNT_NOT_FOUND')
    if (isProtectedNativeAccount(actual, connection).protected) {
      throw new NativeAccountServiceError('PROTECTED_ACCOUNT')
    }
    const verificationIntervalMs = input.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS
    this.validateSettings(verificationIntervalMs, actual.connectionLimit)
    const id = randomUUID()
    const sealed = this.credentials.seal(id, input.password)
    await this.gateways[connection.engine].rotatePassword(connection, identity, sealed.password)
    const timestamp = this.now().toISOString()
    const account: StoredNativeAccount = {
      id,
      connectionId: input.connectionId,
      identity,
      encryptedPassword: sealed.encryptedPassword,
      verificationDatabase: input.verificationDatabase?.trim() || connection.database,
      verificationIntervalMs,
      canLogin: actual.canLogin,
      connectionLimit: actual.connectionLimit,
      status: actual.canLogin ? 'active' : 'disabled',
      verificationFailures: 0,
      nextVerificationAt: new Date(this.now().getTime() + verificationIntervalMs).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.repository.save(account)
    await this.audit(actor, account, 'native-account-adopt', 'success')
    return { account, ...(actor.role === 'admin' ? { password: sealed.password } : {}) }
  }

  async setEnabled(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    enabled: boolean,
    confirmed: boolean,
  ): Promise<void> {
    if (!enabled && !confirmed) throw new NativeAccountServiceError('CONFIRMATION_REQUIRED')
    const { account, connection } = await this.loadManaged(actor, accountId, true)
    await this.gateways[connection.engine].setAccountEnabled(
      connection,
      account.identity,
      enabled,
      this.credentials.reveal(account.id, account.encryptedPassword),
    )
    await this.repository.save({
      ...account,
      canLogin: enabled,
      status: enabled ? 'active' : 'disabled',
      updatedAt: this.now().toISOString(),
    })
    await this.audit(
      actor,
      account,
      enabled ? 'native-account-enable' : 'native-account-disable',
      'success',
    )
  }

  async delete(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    confirmed: boolean,
  ): Promise<void> {
    if (!confirmed) throw new NativeAccountServiceError('CONFIRMATION_REQUIRED')
    const { account, connection } = await this.loadManaged(actor, accountId, true)
    await this.gateways[connection.engine].deleteAccount(connection, account.identity)
    const deletedAt = this.now()
    await this.repository.save({
      ...account,
      status: 'deleted',
      deletedAt: deletedAt.toISOString(),
      recoverUntil: new Date(deletedAt.getTime() + RECOVERY_WINDOW_MS).toISOString(),
      updatedAt: deletedAt.toISOString(),
    })
    await this.audit(actor, account, 'native-account-delete', 'success')
  }

  async restore(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    confirmed: boolean,
  ): Promise<void> {
    if (!confirmed) throw new NativeAccountServiceError('CONFIRMATION_REQUIRED')
    const account = await this.repository.findById(accountId)
    if (!account || account.status !== 'deleted') {
      throw new NativeAccountServiceError('ACCOUNT_NOT_FOUND')
    }
    await this.requireAuthorized(actor, account.connectionId)
    if (!account.recoverUntil || this.now().getTime() > new Date(account.recoverUntil).getTime()) {
      throw new NativeAccountServiceError('RECOVERY_EXPIRED')
    }
    const connection = await this.connections.resolveConnection(account.connectionId)
    const protection = isProtectedNativeAccount(
      { identity: account.identity, systemAccount: false },
      connection,
    )
    if (protection.protected) throw new NativeAccountServiceError('PROTECTED_ACCOUNT')
    await this.gateways[connection.engine].createAccount(connection, {
      identity: account.identity,
      password: this.credentials.reveal(account.id, account.encryptedPassword),
      canLogin: account.canLogin,
      connectionLimit: account.connectionLimit,
    })
    const { deletedAt: _deletedAt, recoverUntil: _recoverUntil, ...retained } = account
    void _deletedAt
    void _recoverUntil
    await this.repository.save({
      ...retained,
      status: account.canLogin ? 'active' : 'disabled',
      updatedAt: this.now().toISOString(),
    })
    await this.audit(actor, account, 'native-account-restore', 'success')
  }

  async rotatePassword(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    password?: string,
  ): Promise<CreatedNativeAccount> {
    const { account, connection } = await this.loadManaged(actor, accountId, true)
    const sealed = this.credentials.seal(account.id, password)
    await this.gateways[connection.engine].rotatePassword(
      connection,
      account.identity,
      sealed.password,
    )
    const { retryVerificationAt: _retry, ...retained } = account
    void _retry
    const updated: StoredNativeAccount = {
      ...retained,
      encryptedPassword: sealed.encryptedPassword,
      status: account.canLogin ? 'active' : 'disabled',
      verificationFailures: 0,
      nextVerificationAt: new Date(this.now().getTime() + account.verificationIntervalMs).toISOString(),
      updatedAt: this.now().toISOString(),
    }
    await this.repository.save(updated)
    await this.audit(actor, updated, 'native-account-password-rotate', 'success')
    return { account: updated, ...(actor.role === 'admin' ? { password: sealed.password } : {}) }
  }

  async revealPassword(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    webPassword: string,
  ): Promise<string> {
    if (actor.role !== 'admin') throw new NativeAccountServiceError('FORBIDDEN')
    const account = await this.repository.findById(accountId)
    if (!account || account.status === 'deleted') throw new NativeAccountServiceError('ACCOUNT_NOT_FOUND')
    await this.requireAuthorized(actor, account.connectionId)
    if (!(await this.reauthenticate(actor.id, webPassword))) {
      await this.audit(
        actor,
        account,
        'native-account-password-reveal',
        'failed',
        'REAUTHENTICATION_FAILED',
      )
      throw new NativeAccountServiceError('REAUTHENTICATION_FAILED')
    }
    await this.audit(actor, account, 'native-account-password-reveal', 'success')
    return this.credentials.reveal(account.id, account.encryptedPassword)
  }

  async verifyNow(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
  ): Promise<void> {
    const { account, connection } = await this.loadManaged(actor, accountId, true)
    const timestamp = this.now()
    try {
      await this.gateways[connection.engine].verifyCredential(
        connection,
        account.verificationDatabase,
        account.identity,
        this.credentials.reveal(account.id, account.encryptedPassword),
      )
    } catch (error) {
      if (error instanceof DatabaseOperationGateError) throw error
      const { retryVerificationAt: _retry, ...retained } = account
      void _retry
      const stale: StoredNativeAccount = {
        ...retained,
        status: 'credential-stale',
        verificationFailures: 0,
        nextVerificationAt: new Date(timestamp.getTime() + account.verificationIntervalMs).toISOString(),
        updatedAt: timestamp.toISOString(),
      }
      await this.repository.save(stale)
      await this.audit(
        actor,
        stale,
        'native-account-verification',
        'failed',
        'CREDENTIAL_VERIFICATION_FAILED',
      )
      throw error
    }
    const { retryVerificationAt: _retry, ...retained } = account
    void _retry
    const verified: StoredNativeAccount = {
      ...retained,
      status: account.canLogin ? 'active' : 'disabled',
      verificationFailures: 0,
      lastVerifiedAt: timestamp.toISOString(),
      nextVerificationAt: new Date(timestamp.getTime() + account.verificationIntervalMs).toISOString(),
      updatedAt: timestamp.toISOString(),
    }
    await this.repository.save(verified)
    await this.audit(actor, verified, 'native-account-verification', 'success')
  }

  private async audit(
    actor: Pick<AuthUser, 'id' | 'role'>,
    account: StoredNativeAccount,
    action: SecurityAuditAction,
    status: 'success' | 'failed',
    errorCode?: string,
  ): Promise<void> {
    await this.securityAudit?.record({
      actorId: actor.id,
      connectionId: account.connectionId,
      action,
      status,
      details: {
        nativeAccountId: account.id,
        nativeIdentity: identityKey(account.identity),
      },
      ...(errorCode ? { errorCode } : {}),
    })
  }

  private validateSettings(verificationIntervalMs: number, connectionLimit: number): void {
    if (
      verificationIntervalMs < MIN_VERIFICATION_INTERVAL_MS ||
      verificationIntervalMs > MAX_VERIFICATION_INTERVAL_MS ||
      !Number.isInteger(connectionLimit) ||
      connectionLimit < -1
    ) throw new NativeAccountServiceError('INVALID_ACCOUNT')
  }

  private async loadManaged(
    actor: Pick<AuthUser, 'id' | 'role'>,
    accountId: string,
    requireActual: boolean,
  ): Promise<{ account: StoredNativeAccount; connection: ResolvedConnection }> {
    const account = await this.repository.findById(accountId)
    if (!account || account.status === 'deleted') throw new NativeAccountServiceError('ACCOUNT_NOT_FOUND')
    await this.requireAuthorized(actor, account.connectionId)
    const connection = await this.connections.resolveConnection(account.connectionId)
    if (requireActual) {
      const actual = (await this.gateways[connection.engine].listAccounts(connection))
        .find((candidate) => identityKey(candidate.identity) === identityKey(account.identity))
      if (!actual) throw new NativeAccountServiceError('ACCOUNT_NOT_FOUND')
      if (isProtectedNativeAccount(actual, connection).protected) {
        throw new NativeAccountServiceError('PROTECTED_ACCOUNT')
      }
    }
    return { account, connection }
  }

  private async requireAuthorized(
    actor: Pick<AuthUser, 'id' | 'role'>,
    connectionId: string,
  ): Promise<void> {
    if (!(await this.authorize(actor, connectionId))) {
      throw new NativeAccountServiceError('FORBIDDEN')
    }
  }
}

export class MemoryNativeAccountRepository implements NativeAccountRepository {
  private readonly accounts = new Map<string, StoredNativeAccount>()

  async findById(id: string): Promise<StoredNativeAccount | undefined> {
    const account = [...this.accounts.values()].find((candidate) => candidate.id === id)
    return account ? structuredClone(account) : undefined
  }

  async findByIdentity(
    connectionId: string,
    identity: NativeAccountIdentity,
  ): Promise<StoredNativeAccount | undefined> {
    const account = this.accounts.get(this.key(connectionId, identity))
    return account ? structuredClone(account) : undefined
  }

  async listByConnection(connectionId: string): Promise<StoredNativeAccount[]> {
    return [...this.accounts.values()]
      .filter((account) => account.connectionId === connectionId)
      .map((account) => structuredClone(account))
  }

  async listDue(now: string): Promise<StoredNativeAccount[]> {
    const timestamp = new Date(now).getTime()
    return [...this.accounts.values()]
      .filter((account) => account.status !== 'deleted')
      .filter((account) => {
        const due = account.retryVerificationAt ?? account.nextVerificationAt
        return new Date(due).getTime() <= timestamp
      })
      .map((account) => structuredClone(account))
  }

  async save(account: StoredNativeAccount): Promise<void> {
    this.accounts.set(this.key(account.connectionId, account.identity), structuredClone(account))
  }

  async deleteExpiredRecovery(now: string): Promise<number> {
    const timestamp = new Date(now).getTime()
    let deleted = 0
    for (const [key, account] of this.accounts) {
      if (
        account.status === 'deleted'
        && account.recoverUntil
        && new Date(account.recoverUntil).getTime() <= timestamp
      ) {
        this.accounts.delete(key)
        deleted += 1
      }
    }
    return deleted
  }

  private key(connectionId: string, identity: NativeAccountIdentity): string {
    return `${connectionId}:${identityKey(identity)}`
  }
}
