import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseOperationLeaseService } from '../ha/database-operation-gate.js'
import { KyselyDatabaseOperationLeaseRepository } from './kysely-database-operation-lease-repository.js'
import { createMetadataDatabase, migrateMetadata, type MetadataKysely } from './metadata-database.js'

describe('KyselyDatabaseOperationLeaseRepository', () => {
  let database: MetadataKysely | undefined

  afterEach(async () => {
    await database?.destroy()
  })

  it('原子限制跨實例的全域與每connection操作數', async () => {
    database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const service = new DatabaseOperationLeaseService(
      new KyselyDatabaseOperationLeaseRepository(database),
      { globalLimit: 2, connectionLimit: 1 },
    )
    const now = new Date('2026-08-01T00:00:00.000Z')

    const results = await Promise.all([
      service.tryAcquire('instance-a', 'connection-a', now),
      service.tryAcquire('instance-b', 'connection-a', now),
      service.tryAcquire('instance-c', 'connection-b', now),
    ])

    expect(results.filter(Boolean)).toHaveLength(2)
    expect(results.filter(Boolean).map((lease) => lease!.connectionId).sort())
      .toEqual(['connection-a', 'connection-b'])
  })

  it('清除過期租約並持久化持有者檢查', async () => {
    database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const service = new DatabaseOperationLeaseService(
      new KyselyDatabaseOperationLeaseRepository(database),
      { globalLimit: 1, connectionLimit: 1, leaseDurationMs: 60_000 },
    )
    const first = await service.tryAcquire(
      'instance-a',
      'connection-a',
      new Date('2026-08-01T00:00:00.000Z'),
    )

    await expect(service.heartbeat(
      first!.id,
      'instance-b',
      new Date('2026-08-01T00:00:10.000Z'),
    )).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' })
    await expect(service.release(first!.id, 'instance-b'))
      .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' })

    const replacement = await service.tryAcquire(
      'instance-b',
      'connection-b',
      new Date('2026-08-01T00:01:00.001Z'),
    )
    expect(replacement).toMatchObject({ ownerId: 'instance-b', connectionId: 'connection-b' })
  })
})
