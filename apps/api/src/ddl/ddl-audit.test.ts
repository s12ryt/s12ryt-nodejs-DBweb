import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedDdlAuditRecorder, MemoryDdlAuditRepository } from './ddl-audit.js'

describe('EncryptedDdlAuditRecorder', () => {
  it('以每筆AAD加密SQL templates並保留90天', async () => {
    const repository = new MemoryDdlAuditRepository()
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 17))
    const now = new Date('2026-07-31T00:00:00.000Z')
    const recorder = new EncryptedDdlAuditRecorder(repository, encryption, () => now)

    await recorder.record({
      actorId: 'admin-1', connectionId: 'connection-1', objectType: 'table',
      objectName: 'public.orders', action: 'create-table', statementCount: 1,
      transactional: true, status: 'success',
      sqlTemplates: ['CREATE TABLE "public"."orders" ("secret" text)'],
      createdAt: now.toISOString(),
    })

    const [stored] = await repository.list()
    expect(stored).toMatchObject({
      actorId: 'admin-1', objectType: 'table', objectName: 'public.orders',
      action: 'create-table', statementCount: 1, transactional: true,
      status: 'success', expiresAt: '2026-10-29T00:00:00.000Z',
    })
    expect(stored?.encryptedSqlTemplates).not.toContain('CREATE TABLE')
    expect(JSON.parse(encryption.decrypt(
      stored!.encryptedSqlTemplates,
      `ddl-audit:${stored!.id}`,
    ))).toEqual(['CREATE TABLE "public"."orders" ("secret" text)'])
  })
})
