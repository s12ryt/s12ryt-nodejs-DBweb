import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedSecurityAuditRecorder } from '../security/security-audit.js'
import { KyselySecurityAuditRepository } from './kysely-security-audit-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselySecurityAuditRepository', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true })))
  })

  it('SQLite重開後保留365天安全事件且檔案不含加密細節明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-security-audit-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const first = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(first)
    const recorder = new EncryptedSecurityAuditRecorder(
      new KyselySecurityAuditRepository(first),
      new EnvelopeEncryption(Buffer.alloc(32, 51)),
      () => new Date('2026-07-31T12:00:00.000Z'),
    )
    await recorder.record({
      actorId: 'admin-1',
      targetUserId: 'user-1',
      action: 'web-user-role-change',
      status: 'success',
      details: { role: 'admin' },
    })
    await first.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    const [stored] = await new KyselySecurityAuditRepository(reopened).list()
    expect(stored).toMatchObject({
      actorId: 'admin-1',
      targetUserId: 'user-1',
      action: 'web-user-role-change',
      expiresAt: '2027-07-31T12:00:00.000Z',
    })
    await reopened.destroy()
    expect((await readFile(filename)).includes(Buffer.from('{"role":"admin"}'))).toBe(false)
  })
})
