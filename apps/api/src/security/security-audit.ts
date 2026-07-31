import { randomUUID } from 'node:crypto'

import type { WebCapability } from '../access/web-access-service.js'
import type { UserRole } from '../auth/auth-types.js'
import type { EnvelopeEncryption } from './envelope-encryption.js'

export type SecurityAuditAction =
  | 'native-account-adopt'
  | 'native-account-create'
  | 'native-account-delete'
  | 'native-account-disable'
  | 'native-account-enable'
  | 'native-account-password-reveal'
  | 'native-account-password-rotate'
  | 'native-account-restore'
  | 'native-account-verification'
  | 'password-change'
  | 'password-reset'
  | 'web-access-assign'
  | 'web-access-revoke'
  | 'web-user-create'
  | 'web-user-delete'
  | 'web-user-enable'
  | 'web-user-disable'
  | 'web-user-role-change'

export interface SecurityAuditDetails {
  capabilities?: WebCapability[]
  enabled?: boolean
  role?: UserRole
  nativeAccountId?: string
  nativeIdentity?: string
  verificationStatus?: 'success' | 'retry-scheduled' | 'credential-stale'
}

export interface SecurityAuditEvent {
  actorId: string
  targetUserId?: string
  connectionId?: string
  action: SecurityAuditAction
  status: 'success' | 'failed'
  details?: SecurityAuditDetails
  errorCode?: string
}

export interface StoredSecurityAudit extends SecurityAuditEvent {
  id: string
  encryptedDetails: string
  createdAt: string
  expiresAt: string
}

export interface SecurityAuditRepository {
  create(event: StoredSecurityAudit): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export interface SecurityAuditRecorder {
  record(event: SecurityAuditEvent): Promise<void>
}

export class EncryptedSecurityAuditRecorder implements SecurityAuditRecorder {
  constructor(
    private readonly repository: SecurityAuditRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(event: SecurityAuditEvent): Promise<void> {
    const id = randomUUID()
    const createdAt = this.now()
    const expiresAt = new Date(createdAt)
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1)
    await this.repository.create({
      ...event,
      id,
      encryptedDetails: this.encryption.encrypt(
        JSON.stringify(event.details ?? {}),
        `security-audit:${id}`,
      ),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
  }

  async purgeExpired(): Promise<number> {
    return await this.repository.deleteExpired(this.now().toISOString())
  }
}

export class MemorySecurityAuditRepository implements SecurityAuditRepository {
  private readonly events: StoredSecurityAudit[] = []

  async create(event: StoredSecurityAudit): Promise<void> {
    this.events.push(structuredClone(event))
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.events.filter((event) => event.expiresAt > now)
    const deleted = this.events.length - retained.length
    this.events.splice(0, this.events.length, ...retained)
    return deleted
  }

  async list(): Promise<StoredSecurityAudit[]> {
    return structuredClone(this.events)
  }
}
