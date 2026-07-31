import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  EncryptedMutationAuditRecorder,
  MemoryMutationAuditRepository,
} from './mutation-audit.js'

describe('EncryptedMutationAuditRecorder', () => {
  it('加密參數化 SQL template 並保留 90 天，不接受列值', async () => {
    const repository = new MemoryMutationAuditRepository()
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 13))
    const now = new Date('2026-07-31T00:00:00.000Z')
    const recorder = new EncryptedMutationAuditRecorder(repository, encryption, () => now)

    await recorder.record({
      actorId: 'admin-1',
      connectionId: 'connection-1',
      schema: 'public',
      table: 'orders',
      action: 'mutate-rows',
      operationCount: 1,
      affectedRows: 1,
      status: 'success',
      sqlTemplates: ['UPDATE "public"."orders" SET "secret" = $1 WHERE "id" = $2'],
      createdAt: now.toISOString(),
    })

    const [stored] = await repository.list()
    expect(stored).toMatchObject({
      actorId: 'admin-1',
      connectionId: 'connection-1',
      objectType: 'table',
      objectName: 'public.orders',
      action: 'mutate-rows',
      operationCount: 1,
      affectedRows: 1,
      status: 'success',
      expiresAt: '2026-10-29T00:00:00.000Z',
    })
    expect(stored?.encryptedSqlTemplates).not.toContain('UPDATE')
    expect(JSON.parse(encryption.decrypt(
      stored!.encryptedSqlTemplates,
      `mutation-audit:${stored!.id}`,
    ))).toEqual(['UPDATE "public"."orders" SET "secret" = $1 WHERE "id" = $2'])
  })
})
