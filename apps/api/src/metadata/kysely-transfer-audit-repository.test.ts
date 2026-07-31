import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { StoredTransferAudit } from '../transfers/transfer-audit.js'
import { KyselyTransferAuditRepository } from './kysely-transfer-audit-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyTransferAuditRepository', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true }))))

  it('SQLite重開後保留90天稽核且資料檔不含details明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-transfer-audit-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const entry: StoredTransferAudit = {
      id: 'audit-1',
      actorId: 'user-1',
      jobId: 'job-1',
      connectionId: 'connection-1',
      direction: 'export',
      format: 'sql',
      action: 'download',
      status: 'success',
      encryptedDetails: 'v1.encrypted-download-details',
      createdAt: '2026-07-31T12:00:00.000Z',
      expiresAt: '2026-10-29T12:00:00.000Z',
    }
    const first = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(first)
    const repository = new KyselyTransferAuditRepository(first)
    await repository.create(entry)
    await first.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    await expect(new KyselyTransferAuditRepository(reopened).list()).resolves.toEqual([entry])
    await reopened.destroy()
    expect((await readFile(filename)).includes(Buffer.from('sensitive-output-name'))).toBe(false)
  })
})
