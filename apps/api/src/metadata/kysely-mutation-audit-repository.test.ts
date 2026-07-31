import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { StoredMutationAudit } from '../data/mutation-audit.js'
import { KyselyMutationAuditRepository } from './kysely-mutation-audit-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyMutationAuditRepository', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))))

  it('SQLite 重開後保留稽核，且資料檔不含 SQL template 明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-mutation-audit-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const entry: StoredMutationAudit = {
      id: 'audit-1',
      actorId: 'admin-1',
      connectionId: 'connection-1',
      objectType: 'table',
      objectName: 'public.orders',
      action: 'mutate-rows',
      operationCount: 1,
      affectedRows: 1,
      status: 'success',
      encryptedSqlTemplates: 'v1.encrypted-template',
      createdAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-10-29T00:00:00.000Z',
    }
    const first = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(first)
    await new KyselyMutationAuditRepository(first).create(entry)
    await first.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    await expect(new KyselyMutationAuditRepository(reopened).list()).resolves.toEqual([entry])
    await reopened.destroy()

    expect((await readFile(filename)).includes(Buffer.from('UPDATE "public"."orders"'))).toBe(false)
  })
})
