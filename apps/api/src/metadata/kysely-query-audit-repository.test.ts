import { describe, expect, it } from 'vitest'

import type { StoredQueryAudit } from '../audit/query-audit.js'
import { KyselyQueryAuditRepository } from './kysely-query-audit-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

function entry(id: string, expiresAt: string): StoredQueryAudit {
  return {
    id,
    queryId: `query-${id}`,
    userId: 'user-1',
    connectionId: 'connection-1',
    encryptedSql: `v1.encrypted-${id}`,
    status: 'success',
    durationMs: 5,
    rowCount: 1,
    createdAt: '2026-07-31T00:00:00.000Z',
    expiresAt,
  }
}

describe('KyselyQueryAuditRepository', () => {
  it('持久化 ciphertext，並只清除已到期稽核', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const repository = new KyselyQueryAuditRepository(database)
    await repository.create(entry('expired', '2026-07-30T00:00:00.000Z'))
    await repository.create(entry('active', '2026-10-29T00:00:00.000Z'))

    await expect(repository.deleteExpired('2026-07-31T00:00:00.000Z')).resolves.toBe(1)
    await expect(repository.list()).resolves.toEqual([entry('active', '2026-10-29T00:00:00.000Z')])
    await database.destroy()
  })
})
