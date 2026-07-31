import { randomUUID } from 'node:crypto'

import type { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { TransferDirection, TransferFormat } from './transfer-job.js'

export type TransferAuditAction =
  | 'job-create'
  | 'upload-complete'
  | 'preview'
  | 'job-cancel'
  | 'download'
  | 'export'
  | 'import'

export interface TransferAuditDetails {
  includeData?: boolean
  bytes?: number
  checksum?: string
}

export interface TransferAuditEvent {
  actorId: string
  jobId: string
  connectionId: string
  direction: TransferDirection
  format: TransferFormat
  action: TransferAuditAction
  status: 'success' | 'failed'
  details?: TransferAuditDetails
  errorCode?: string
}

export interface StoredTransferAudit extends Omit<TransferAuditEvent, 'details'> {
  id: string
  encryptedDetails: string
  createdAt: string
  expiresAt: string
}

export interface TransferAuditRepository {
  create(entry: StoredTransferAudit): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export interface TransferAuditRecorder {
  record(event: TransferAuditEvent): Promise<void>
}

export class EncryptedTransferAuditRecorder implements TransferAuditRecorder {
  constructor(
    private readonly repository: TransferAuditRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(event: TransferAuditEvent): Promise<void> {
    const id = randomUUID()
    const createdAt = this.now()
    await this.repository.create({
      actorId: event.actorId,
      jobId: event.jobId,
      connectionId: event.connectionId,
      direction: event.direction,
      format: event.format,
      action: event.action,
      status: event.status,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      id,
      encryptedDetails: this.encryption.encrypt(
        JSON.stringify(event.details ?? {}),
        `transfer-audit:${id}`,
      ),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 90 * 24 * 60 * 60_000).toISOString(),
    })
  }

  async purgeExpired(): Promise<number> {
    return this.repository.deleteExpired(this.now().toISOString())
  }
}

export class MemoryTransferAuditRepository implements TransferAuditRepository {
  private readonly entries: StoredTransferAudit[] = []

  async create(entry: StoredTransferAudit): Promise<void> {
    this.entries.push(structuredClone(entry))
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.entries.filter((entry) => entry.expiresAt > now)
    const deleted = this.entries.length - retained.length
    this.entries.splice(0, this.entries.length, ...retained)
    return deleted
  }

  async list(): Promise<StoredTransferAudit[]> {
    return structuredClone(this.entries)
  }
}
