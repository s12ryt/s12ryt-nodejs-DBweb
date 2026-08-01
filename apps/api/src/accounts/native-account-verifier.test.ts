import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { SecurityAuditRecorder } from '../security/security-audit.js'
import { NativeAccountCredentialVault } from './native-account-credential.js'
import {
  MemoryNativeAccountRepository,
  type NativeAccountGateway,
  type StoredNativeAccount,
} from './native-account-service.js'
import {
  NativeAccountVerificationScheduler,
  NativeAccountVerifier,
} from './native-account-verifier.js'

afterEach(() => vi.useRealTimers())

const connection: ResolvedConnection = {
  id: 'connection-1', name: 'PG', engine: 'postgres', host: 'database.test', port: 5432,
  database: 'app', username: 'dbweb', password: 'connection-secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}

function account(id: string, encryptedPassword: string): StoredNativeAccount {
  return {
    id, connectionId: connection.id, identity: { engine: 'postgres', username: `user_${id}` },
    encryptedPassword, verificationDatabase: 'verification_db', verificationIntervalMs: 21_600_000,
    canLogin: true, connectionLimit: -1, status: 'active', verificationFailures: 0,
    nextVerificationAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z',
  }
}

function setup(verifyCredential: NativeAccountGateway['verifyCredential']) {
  const vault = new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 7)))
  const repository = new MemoryNativeAccountRepository()
  const gateway: NativeAccountGateway = {
    listAccounts: vi.fn(async () => []), createAccount: vi.fn(async () => undefined),
    rotatePassword: vi.fn(async () => undefined), setAccountEnabled: vi.fn(async () => undefined),
    deleteAccount: vi.fn(async () => undefined), verifyCredential,
  }
  const securityAudit: SecurityAuditRecorder = { record: vi.fn(async () => undefined) }
  const verifier = new NativeAccountVerifier(
    { resolveConnection: vi.fn(async () => connection) },
    { postgres: gateway, mysql: gateway },
    repository,
    vault,
    () => new Date('2026-07-31T00:00:00.000Z'),
    securityAudit,
  )
  return { repository, securityAudit, vault, verifier }
}

describe('NativeAccountVerifier', () => {
  it('decrypts credentials, uses the selected database, and caps each connection at five concurrent checks', async () => {
    let active = 0
    let maximum = 0
    const verifyCredential = vi.fn<NativeAccountGateway['verifyCredential']>(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })
    const { repository, vault, verifier } = setup(verifyCredential)
    for (let index = 0; index < 7; index += 1) {
      const id = `account-${index}`
      await repository.save(account(id, vault.seal(id, `password-value-${index}`).encryptedPassword))
    }

    await verifier.tick()

    expect(maximum).toBe(5)
    expect(verifyCredential).toHaveBeenCalledWith(
      connection,
      'verification_db',
      { engine: 'postgres', username: 'user_account-0' },
      'password-value-0',
    )
    expect(await repository.findById('account-0')).toMatchObject({
      status: 'active', verificationFailures: 0,
      lastVerifiedAt: '2026-07-31T00:00:00.000Z',
      nextVerificationAt: '2026-07-31T06:00:00.000Z',
    })
  })

  it('retries once after thirty minutes, then marks credentials stale until the next normal cycle', async () => {
    const verifyCredential = vi.fn<NativeAccountGateway['verifyCredential']>(async () => {
      throw new Error('driver-secret')
    })
    const { repository, securityAudit, vault, verifier } = setup(verifyCredential)
    const id = 'account-1'
    await repository.save(account(id, vault.seal(id, 'password-value-1').encryptedPassword))

    await verifier.tick()
    expect(await repository.findById(id)).toMatchObject({
      status: 'active', verificationFailures: 1,
      retryVerificationAt: '2026-07-31T00:30:00.000Z',
    })

    await verifier.verifyDueAt(new Date('2026-07-31T00:30:00.000Z'))
    expect(await repository.findById(id)).toMatchObject({
      status: 'credential-stale', verificationFailures: 0,
      nextVerificationAt: '2026-07-31T06:30:00.000Z',
    })
    expect(await repository.findById(id)).not.toHaveProperty('retryVerificationAt')
    expect(JSON.stringify(await repository.findById(id))).not.toContain('driver-secret')
    expect(vi.mocked(securityAudit.record).mock.calls.map(([event]) => [event.action, event.status])).toEqual([
      ['native-account-verification', 'failed'],
      ['native-account-verification', 'failed'],
    ])
    expect(JSON.stringify(vi.mocked(securityAudit.record).mock.calls)).not.toContain('driver-secret')
  })

  it('does not treat database capacity limits as credential failures', async () => {
    const busy = new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true)
    const verifyCredential = vi.fn<NativeAccountGateway['verifyCredential']>(async () => {
      throw busy
    })
    const { repository, securityAudit, vault, verifier } = setup(verifyCredential)
    const id = 'capacity-limited'
    await repository.save(account(id, vault.seal(id, 'password-value-long').encryptedPassword))
    const before = await repository.findById(id)

    await verifier.tick()

    expect(await repository.findById(id)).toEqual(before)
    expect(securityAudit.record).not.toHaveBeenCalled()
  })

  it('schedules an immediate non-overlapping check and waits for it during shutdown', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const tick = vi.fn(async () => new Promise<void>((resolve) => {
      release = resolve
    }))
    const scheduler = new NativeAccountVerificationScheduler({ tick }, 1_000)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(tick).toHaveBeenCalledOnce()

    let stopped = false
    const stopping = scheduler.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release?.()
    await stopping
    expect(stopped).toBe(true)
  })

  it('continues checking after a failed scheduled tick', async () => {
    vi.useFakeTimers()
    const tick = vi.fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValue(undefined)
    const scheduler = new NativeAccountVerificationScheduler({ tick }, 1_000)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tick).toHaveBeenCalledTimes(2)
    await scheduler.stop()
  })
})
