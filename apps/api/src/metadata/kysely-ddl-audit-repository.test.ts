import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedDdlAuditRecorder } from '../ddl/ddl-audit.js'
import type { StoredDdlAudit } from '../ddl/ddl-audit.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { KyselyDdlAuditRepository } from './kysely-ddl-audit-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyDdlAuditRepository', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))))

  it('SQLite重開後保留稽核且檔案不含SQL明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-ddl-audit-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const entry: StoredDdlAudit = {
      id: 'ddl-audit-1', actorId: 'admin-1', connectionId: 'connection-1',
      objectType: 'table', objectName: 'public.orders', action: 'create-table',
      statementCount: 1, transactional: true, status: 'success',
      encryptedSqlTemplates: 'v1.encrypted-ddl', createdAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-10-29T00:00:00.000Z',
    }
    const first = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(first)
    await new KyselyDdlAuditRepository(first).create(entry)
    await first.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    await expect(new KyselyDdlAuditRepository(reopened).list()).resolves.toEqual([entry])
    await reopened.destroy()

    expect((await readFile(filename)).includes(Buffer.from('CREATE TABLE "public"."orders"'))).toBe(false)
  })

  it('程式碼物件原文只以加密SQL template寫入SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-ddl-code-audit-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const database = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(database)
    const repository = new KyselyDdlAuditRepository(database)
    const recorder = new EncryptedDdlAuditRecorder(
      repository,
      new EnvelopeEncryption(Buffer.alloc(32, 23)),
      () => new Date('2026-07-31T00:00:00.000Z'),
    )
    const functionSql = 'CREATE FUNCTION "public"."mask_email"() RETURNS text LANGUAGE sql AS $dbweb$SELECT \'classified-body\'$dbweb$'

    await recorder.record({
      actorId: 'admin-1', connectionId: 'connection-1', objectType: 'function',
      objectName: 'public.mask_email', action: 'create-routine', statementCount: 1,
      transactional: true, status: 'success', sqlTemplates: [functionSql],
      createdAt: '2026-07-31T00:00:00.000Z',
    })
    await database.destroy()

    expect((await readFile(filename)).includes(Buffer.from('classified-body'))).toBe(false)
  })
})
