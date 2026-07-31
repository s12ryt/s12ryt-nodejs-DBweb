import { randomUUID } from 'node:crypto'

import type { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { DdlAuditEntry, DdlAuditRecorder } from './ddl-service.js'

export interface StoredDdlAudit {
  id: string
  actorId: string
  connectionId: string
  objectType: DdlAuditEntry['objectType']
  objectName: string
  action: DdlAuditEntry['action']
  statementCount: number
  transactional: boolean
  status: 'success' | 'failed'
  encryptedSqlTemplates: string
  errorCode?: string
  createdAt: string
  expiresAt: string
}

export interface DdlAuditRepository {
  create(entry: StoredDdlAudit): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export class EncryptedDdlAuditRecorder implements DdlAuditRecorder {
  constructor(
    private readonly repository: DdlAuditRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: DdlAuditEntry): Promise<void> {
    const id = randomUUID()
    await this.repository.create({
      id,
      actorId: entry.actorId,
      connectionId: entry.connectionId,
      objectType: entry.objectType,
      objectName: entry.objectName,
      action: entry.action,
      statementCount: entry.statementCount,
      transactional: entry.transactional,
      status: entry.status,
      encryptedSqlTemplates: this.encryption.encrypt(
        JSON.stringify(entry.sqlTemplates),
        `ddl-audit:${id}`,
      ),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      createdAt: entry.createdAt,
      expiresAt: new Date(this.now().getTime() + 90 * 24 * 60 * 60_000).toISOString(),
    })
  }

  async purgeExpired(): Promise<number> {
    return this.repository.deleteExpired(this.now().toISOString())
  }
}

export class MemoryDdlAuditRepository implements DdlAuditRepository {
  private readonly entries: StoredDdlAudit[] = []

  async create(entry: StoredDdlAudit): Promise<void> {
    this.entries.push(structuredClone(entry))
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.entries.filter((entry) => entry.expiresAt > now)
    const deleted = this.entries.length - retained.length
    this.entries.splice(0, this.entries.length, ...retained)
    return deleted
  }

  async list(): Promise<StoredDdlAudit[]> {
    return structuredClone(this.entries)
  }
}
