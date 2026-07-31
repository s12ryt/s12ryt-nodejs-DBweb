import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { StoredDdlAudit } from '../ddl/ddl-audit.js'
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
})
