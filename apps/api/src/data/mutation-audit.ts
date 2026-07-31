import { randomUUID } from 'node:crypto'

import type { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { MutationAuditEntry, MutationAuditRecorder } from './data-mutation-service.js'

export interface StoredMutationAudit {
  id: string
  actorId: string
  connectionId: string
  objectType: 'table'
  objectName: string
  action: 'mutate-rows'
  operationCount: number
  affectedRows: number
  status: 'success' | 'failed'
  encryptedSqlTemplates: string
  errorCode?: string
  createdAt: string
  expiresAt: string
}

export interface MutationAuditRepository {
  create(entry: StoredMutationAudit): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export class EncryptedMutationAuditRecorder implements MutationAuditRecorder {
  constructor(
    private readonly repository: MutationAuditRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: MutationAuditEntry): Promise<void> {
    const id = randomUUID()
    const expiresAt = new Date(this.now().getTime() + 90 * 24 * 60 * 60_000).toISOString()
    await this.repository.create({
      id,
      actorId: entry.actorId,
      connectionId: entry.connectionId,
      objectType: 'table',
      objectName: `${entry.schema}.${entry.table}`,
      action: entry.action,
      operationCount: entry.operationCount,
      affectedRows: entry.affectedRows,
      status: entry.status,
      encryptedSqlTemplates: this.encryption.encrypt(
        JSON.stringify(entry.sqlTemplates),
        `mutation-audit:${id}`,
      ),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      createdAt: entry.createdAt,
      expiresAt,
    })
  }

  async purgeExpired(): Promise<number> {
    return this.repository.deleteExpired(this.now().toISOString())
  }
}

export class MemoryMutationAuditRepository implements MutationAuditRepository {
  private readonly entries: StoredMutationAudit[] = []

  async create(entry: StoredMutationAudit): Promise<void> {
    this.entries.push(structuredClone(entry))
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.entries.filter((entry) => entry.expiresAt > now)
    const deleted = this.entries.length - retained.length
    this.entries.splice(0, this.entries.length, ...retained)
    return deleted
  }

  async list(): Promise<StoredMutationAudit[]> {
    return structuredClone(this.entries)
  }
}
