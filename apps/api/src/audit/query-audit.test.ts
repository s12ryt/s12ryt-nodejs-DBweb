import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  EncryptedQueryAuditRecorder,
  MemoryQueryAuditRepository,
  redactSqlCredentials,
} from './query-audit.js'

describe('query audit', () => {
  it('遮蔽明確憑證但保留其餘完整 SQL', () => {
    const sql = [
      "CREATE USER app PASSWORD 'plain-secret'",
      'CREATE USER x IDENTIFIED BY "other-secret"',
      "SELECT 'postgres://reader:uri-secret@db/app'",
      'SELECT * FROM orders WHERE id = 7',
    ].join('; ')

    const redacted = redactSqlCredentials(sql)
    expect(redacted).not.toContain('plain-secret')
    expect(redacted).not.toContain('other-secret')
    expect(redacted).not.toContain('uri-secret')
    expect(redacted).toContain('SELECT * FROM orders WHERE id = 7')
    expect(redacted).toContain('[REDACTED]')
  })

  it('以 audit id 綁定 AAD 加密 SQL，並設定 90 天保存期限', async () => {
    const repository = new MemoryQueryAuditRepository()
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 9))
    const now = new Date('2026-07-31T00:00:00.000Z')
    const recorder = new EncryptedQueryAuditRecorder(repository, encryption, () => now)

    await recorder.record({
      queryId: 'query-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      sql: "SELECT * FROM users; ALTER USER admin PASSWORD 'do-not-store'",
      status: 'success',
      durationMs: 20,
      rowCount: 2,
      createdAt: now.toISOString(),
    })

    const [stored] = await repository.list()
    expect(stored?.encryptedSql).not.toContain('do-not-store')
    expect(stored?.expiresAt).toBe('2026-10-29T00:00:00.000Z')
    expect(
      encryption.decrypt(stored?.encryptedSql ?? '', `audit:${stored?.id ?? ''}`),
    ).toContain("PASSWORD '[REDACTED]'")
  })
})
