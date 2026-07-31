import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedTransferAuditRecorder, MemoryTransferAuditRepository } from './transfer-audit.js'

describe('EncryptedTransferAuditRecorder', () => {
  it('以job用途綁定加密details並保存90天，不把檔案內容納入事件契約', async () => {
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 14))
    const repository = new MemoryTransferAuditRepository()
    const recorder = new EncryptedTransferAuditRecorder(
      repository,
      encryption,
      () => new Date('2026-07-31T12:00:00.000Z'),
    )
    await recorder.record({
      actorId: 'user-1',
      jobId: 'job-1',
      connectionId: 'connection-1',
      direction: 'import',
      format: 'json',
      action: 'upload-complete',
      status: 'success',
      details: { bytes: 42, checksum: 'a'.repeat(64) },
    })

    const [stored] = await repository.list()
    expect(stored).toMatchObject({
      actorId: 'user-1',
      jobId: 'job-1',
      action: 'upload-complete',
      expiresAt: '2026-10-29T12:00:00.000Z',
    })
    expect(stored?.encryptedDetails).not.toContain('a'.repeat(64))
    expect(JSON.parse(encryption.decrypt(
      stored!.encryptedDetails,
      `transfer-audit:${stored!.id}`,
    ))).toEqual({ bytes: 42, checksum: 'a'.repeat(64) })
  })
})
