import { describe, expect, it } from 'vitest'

import type { StoredKeepAliveEvent } from '../keepalive/keepalive-event.js'
import { KyselyKeepAliveEventRepository } from './kysely-keepalive-event-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

function event(id: string, expiresAt: string): StoredKeepAliveEvent {
  return {
    id,
    connectionId: 'connection-1',
    status: id === 'timeout' ? 'timeout' : 'success',
    durationMs: 10,
    createdAt: '2026-07-31T00:00:00.000Z',
    expiresAt,
  }
}

describe('KyselyKeepAliveEventRepository', () => {
  it('持久化狀態並只清除已到期事件', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    const repository = new KyselyKeepAliveEventRepository(database)
    await repository.create(event('timeout', '2026-07-30T00:00:00.000Z'))
    await repository.create(event('active', '2026-10-29T00:00:00.000Z'))

    await expect(repository.deleteExpired('2026-07-31T00:00:00.000Z')).resolves.toBe(1)
    await expect(repository.list()).resolves.toEqual([
      event('active', '2026-10-29T00:00:00.000Z'),
    ])
    await database.destroy()
  })
})
