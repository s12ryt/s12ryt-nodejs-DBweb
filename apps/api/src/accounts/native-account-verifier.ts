import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import type { SecurityAuditRecorder } from '../security/security-audit.js'
import type { NativeAccountCredentialVault } from './native-account-credential.js'
import type {
  NativeAccountGateway,
  NativeAccountRepository,
  StoredNativeAccount,
} from './native-account-service.js'

const RETRY_DELAY_MS = 30 * 60 * 1000
const MAX_CONCURRENT_PER_CONNECTION = 5
const DEFAULT_REFRESH_INTERVAL_MS = 60_000

interface NativeAccountVerifierLike {
  tick(): Promise<void>
}

export class NativeAccountVerificationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private currentTick: Promise<void> | undefined

  constructor(
    private readonly verifier: NativeAccountVerifierLike,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return
    this.trigger()
    this.timer = setInterval(() => this.trigger(), this.refreshIntervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.currentTick
  }

  private trigger(): void {
    if (this.currentTick) return
    const trackedTick = Promise.resolve()
      .then(async () => this.verifier.tick())
      .catch(() => undefined)
      .finally(() => {
        if (this.currentTick === trackedTick) this.currentTick = undefined
      })
    this.currentTick = trackedTick
  }
}

export class NativeAccountVerifier {
  constructor(
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, NativeAccountGateway>,
    private readonly repository: NativeAccountRepository,
    private readonly credentials: NativeAccountCredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly securityAudit?: SecurityAuditRecorder,
  ) {}

  async tick(): Promise<void> {
    await this.verifyDueAt(this.now())
  }

  async verifyDueAt(now: Date): Promise<void> {
    await this.repository.deleteExpiredRecovery(now.toISOString())
    const due = await this.repository.listDue(now.toISOString())
    const groups = new Map<string, StoredNativeAccount[]>()
    for (const account of due) {
      const group = groups.get(account.connectionId) ?? []
      group.push(account)
      groups.set(account.connectionId, group)
    }
    await Promise.all([...groups.entries()].map(async ([connectionId, accounts]) => {
      const connection = await this.connections.resolveConnection(connectionId)
      for (let offset = 0; offset < accounts.length; offset += MAX_CONCURRENT_PER_CONNECTION) {
        await Promise.all(accounts.slice(offset, offset + MAX_CONCURRENT_PER_CONNECTION)
          .map(async (account) => this.verifyOne(account, connection, now)))
      }
    }))
  }

  private async verifyOne(
    account: StoredNativeAccount,
    connection: Awaited<ReturnType<ConnectionService['resolveConnection']>>,
    now: Date,
  ): Promise<void> {
    try {
      await this.gateways[connection.engine].verifyCredential(
        connection,
        account.verificationDatabase,
        account.identity,
        this.credentials.reveal(account.id, account.encryptedPassword),
      )
      const { retryVerificationAt: _retry, ...retained } = account
      void _retry
      await this.repository.save({
        ...retained,
        status: account.canLogin ? 'active' : 'disabled',
        verificationFailures: 0,
        lastVerifiedAt: now.toISOString(),
        nextVerificationAt: new Date(now.getTime() + account.verificationIntervalMs).toISOString(),
        updatedAt: now.toISOString(),
      })
      await this.audit(account, 'success')
    } catch (error) {
      if (error instanceof DatabaseOperationGateError) return
      await this.recordFailure(account, now)
    }
  }

  private async recordFailure(account: StoredNativeAccount, now: Date): Promise<void> {
    if (account.verificationFailures === 0) {
      await this.repository.save({
        ...account,
        verificationFailures: 1,
        retryVerificationAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
        updatedAt: now.toISOString(),
      })
      await this.audit(account, 'retry-scheduled')
      return
    }
    const { retryVerificationAt: _retry, ...retained } = account
    void _retry
    await this.repository.save({
      ...retained,
      status: 'credential-stale',
      verificationFailures: 0,
      nextVerificationAt: new Date(now.getTime() + account.verificationIntervalMs).toISOString(),
      updatedAt: now.toISOString(),
    })
    await this.audit(account, 'credential-stale')
  }

  private async audit(
    account: StoredNativeAccount,
    verificationStatus: 'success' | 'retry-scheduled' | 'credential-stale',
  ): Promise<void> {
    await this.securityAudit?.record({
      actorId: 'system',
      connectionId: account.connectionId,
      action: 'native-account-verification',
      status: verificationStatus === 'success' ? 'success' : 'failed',
      details: {
        nativeAccountId: account.id,
        verificationStatus,
      },
      ...(verificationStatus === 'success' ? {} : { errorCode: 'CREDENTIAL_VERIFICATION_FAILED' }),
    }).catch(() => undefined)
  }
}
