import { describe, expect, it } from 'vitest'

import { KyselyInstanceRoleRepository } from './kysely-instance-role-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyInstanceRoleRepository', () => {
  it('以metadata原子序列化三個實例並限制最多兩個active', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const repository = new KyselyInstanceRoleRepository(database)
    const now = new Date('2026-08-01T00:00:00.000Z')

    const leases = await Promise.all([
      repository.heartbeat('api-1', now, 20_000, 2),
      repository.heartbeat('api-2', now, 20_000, 2),
      repository.heartbeat('api-3', now, 20_000, 2),
    ])

    expect(leases.filter((lease) => lease.role === 'active')).toHaveLength(2)
    expect(leases.filter((lease) => lease.role === 'standby')).toHaveLength(1)
    await database.destroy()
  })

  it('保留未過期active並在lease過期或release後讓standby晉升', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const repository = new KyselyInstanceRoleRepository(database)
    const initial = new Date('2026-08-01T00:00:00.000Z')
    await repository.heartbeat('api-1', initial, 20_000, 2)
    await repository.heartbeat('api-2', initial, 20_000, 2)
    await expect(repository.heartbeat('api-3', initial, 20_000, 2))
      .resolves.toMatchObject({ role: 'standby' })

    await expect(repository.heartbeat(
      'api-3',
      new Date('2026-08-01T00:00:21.000Z'),
      20_000,
      2,
    )).resolves.toMatchObject({ role: 'active' })

    await repository.release('api-3')
    await expect(repository.heartbeat(
      'api-4',
      new Date('2026-08-01T00:00:22.000Z'),
      20_000,
      2,
    )).resolves.toMatchObject({ role: 'active' })
    await database.destroy()
  })
})
