import { randomUUID } from 'node:crypto'

import type { QueryAuditEntry, QueryAuditRecorder, QueryStatus } from '../query/sql-query-service.js'
import type { EnvelopeEncryption } from '../security/envelope-encryption.js'

export interface StoredQueryAudit {
  id: string
  queryId: string
  userId: string
  connectionId: string
  encryptedSql: string
  status: QueryStatus
  durationMs: number
  rowCount: number
  errorCode?: string
  createdAt: string
  expiresAt: string
}

export interface QueryAuditRepository {
  create(entry: StoredQueryAudit): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export function redactSqlCredentials(sql: string): string {
  return sql
    .replace(
      /\b(PASSWORD\s*(?:=\s*)?)(?:'(?:''|[^'])*'|"(?:""|[^"])*")/gi,
      "$1'[REDACTED]'",
    )
    .replace(
      /\b(IDENTIFIED\s+BY\s+)(?:'(?:''|[^'])*'|"(?:""|[^"])*")/gi,
      "$1'[REDACTED]'",
    )
    .replace(
      /\b((?:postgres(?:ql)?|mysql):\/\/[^:\s/'"]+):([^@\s/'"]+)@/gi,
      '$1:[REDACTED]@',
    )
}

export class EncryptedQueryAuditRecorder implements QueryAuditRecorder {
  constructor(
    private readonly repository: QueryAuditRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: QueryAuditEntry): Promise<void> {
    const id = randomUUID()
    const expiresAt = new Date(this.now().getTime() + 90 * 24 * 60 * 60_000).toISOString()
    await this.repository.create({
      id,
      queryId: entry.queryId,
      userId: entry.userId,
      connectionId: entry.connectionId,
      encryptedSql: this.encryption.encrypt(redactSqlCredentials(entry.sql), `audit:${id}`),
      status: entry.status,
      durationMs: entry.durationMs,
      rowCount: entry.rowCount,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      createdAt: entry.createdAt,
      expiresAt,
    })
  }

  async purgeExpired(): Promise<number> {
    return this.repository.deleteExpired(this.now().toISOString())
  }
}

export class MemoryQueryAuditRepository implements QueryAuditRepository {
  private readonly entries: StoredQueryAudit[] = []

  async create(entry: StoredQueryAudit): Promise<void> {
    this.entries.push(structuredClone(entry))
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.entries.filter((entry) => entry.expiresAt > now)
    const deleted = this.entries.length - retained.length
    this.entries.splice(0, this.entries.length, ...retained)
    return deleted
  }

  async list(): Promise<StoredQueryAudit[]> {
    return structuredClone(this.entries)
  }
}
