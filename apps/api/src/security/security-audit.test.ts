import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from './envelope-encryption.js'
import {
  EncryptedSecurityAuditRecorder,
  MemorySecurityAuditRepository,
} from './security-audit.js'

describe('EncryptedSecurityAuditRecorder', () => {
  it('以用途綁定密文保存M4安全事件365天，輸入契約不接受密碼', async () => {
    const repository = new MemorySecurityAuditRepository()
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 41))
    const now = new Date('2026-07-31T12:00:00.000Z')
    const recorder = new EncryptedSecurityAuditRecorder(repository, encryption, () => now)

    await recorder.record({
      actorId: 'admin-1',
      targetUserId: 'user-1',
      connectionId: 'connection-1',
      action: 'web-access-assign',
      status: 'success',
      details: { capabilities: ['structure-read', 'data-read'] },
    })

    const [stored] = await repository.list()
    expect(stored).toMatchObject({
      actorId: 'admin-1',
      targetUserId: 'user-1',
      connectionId: 'connection-1',
      action: 'web-access-assign',
      status: 'success',
      createdAt: now.toISOString(),
      expiresAt: '2027-07-31T12:00:00.000Z',
    })
    expect(stored?.encryptedDetails).not.toContain('structure-read')
    expect(
      JSON.parse(encryption.decrypt(stored?.encryptedDetails ?? '', `security-audit:${stored?.id}`)),
    ).toEqual({ capabilities: ['structure-read', 'data-read'] })
    expect(JSON.stringify(stored)).not.toMatch(/password/i)
  })
})
