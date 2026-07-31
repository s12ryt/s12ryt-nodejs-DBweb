import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { StoredTransferJob } from '../transfers/transfer-job.js'
import { KyselyTransferJobRepository } from './kysely-transfer-job-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) =>
    rm(directory, { force: true, recursive: true }),
  ))
})

function job(id: string, ownerId = 'user-1', connectionId = 'connection-1'): StoredTransferJob {
  return {
    id,
    ownerId,
    connectionId,
    direction: 'import',
    format: 'json',
    includeData: true,
    status: 'queued',
    receivedBytes: 0,
    processedBytes: 0,
    processedRows: 0,
    processedTables: 0,
    errorCount: 0,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    expiresAt: '2026-10-29T00:00:00.000Z',
  }
}

describe('KyselyTransferJobRepository', () => {
  it('原子限制active配額，CAS更新後釋放配額並持久化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-transfer-jobs-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const firstDatabase = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(firstDatabase)
    const first = new KyselyTransferJobRepository(firstDatabase)

    const results = await Promise.all([
      first.createWithinLimits(job('11111111-1111-4111-8111-111111111111'), 2, 2),
      first.createWithinLimits(job('22222222-2222-4222-8222-222222222222'), 2, 2),
      first.createWithinLimits(job('33333333-3333-4333-8333-333333333333'), 2, 2),
      first.createWithinLimits(job('44444444-4444-4444-8444-444444444444'), 2, 2),
    ])

    expect(results.filter((result) => result === 'created')).toHaveLength(2)
    expect(results.filter((result) => result === 'owner-limit')).toHaveLength(2)
    const active = await first.listByOwner('user-1')
    expect(active).toHaveLength(2)

    const cancelled = { ...active[0]!, status: 'cancelled' as const }
    expect(await first.replace(cancelled, 'queued', active[0]!.updatedAt)).toBe(true)
    expect(await first.replace(
      { ...cancelled, status: 'running' },
      'queued',
      active[0]!.updatedAt,
    )).toBe(false)
    expect(await first.createWithinLimits(
      job('55555555-5555-4555-8555-555555555555'),
      2,
      2,
    )).toBe('created')

    await firstDatabase.destroy()
    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    expect(await new KyselyTransferJobRepository(reopened).listAll()).toHaveLength(3)
    await reopened.destroy()
  })

  it('不同owner共享connection時套用connection active配額', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const repository = new KyselyTransferJobRepository(database)

    expect(await repository.createWithinLimits(
      job('11111111-1111-4111-8111-111111111111', 'user-1'), 2, 2,
    )).toBe('created')
    expect(await repository.createWithinLimits(
      job('22222222-2222-4222-8222-222222222222', 'user-2'), 2, 2,
    )).toBe('created')
    expect(await repository.createWithinLimits(
      job('33333333-3333-4333-8333-333333333333', 'user-3'), 2, 2,
    )).toBe('connection-limit')

    await database.destroy()
  })
})
