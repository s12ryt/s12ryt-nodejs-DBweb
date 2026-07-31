import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  DatabaseExplorer,
  ExplorerError,
  type DatabaseGateway,
} from './database-explorer.js'

async function setup() {
  const repository = new MemoryConnectionRepository()
  const encryption = new EnvelopeEncryption(Buffer.alloc(32, 8))
  const testConnector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: '16' })) }
  const connections = new ConnectionService(repository, encryption, {
    postgres: testConnector,
    mysql: testConnector,
  })
  const profile = await connections.create(
    {
      name: 'Main',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      username: 'reader',
      password: 'database-secret',
      tls: { mode: 'disable' },
      keepAlive: { enabled: false },
    },
    'admin',
  )
  const gateway: DatabaseGateway = {
    listSchemas: vi.fn(async () => ['public']),
    listTables: vi.fn(async () => [{ schema: 'public', name: 'orders', type: 'table' as const }]),
    describeTable: vi.fn(async () => [
      { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
    ]),
    readRows: vi.fn(async () => ({ columns: ['id'], rows: [{ id: 1 }], nextOffset: 1 })),
  }
  return { explorer: new DatabaseExplorer(connections, { postgres: gateway, mysql: gateway }), gateway, profile }
}

describe('DatabaseExplorer', () => {
  it('列出 schema、table 與 column，並選用連線 engine 對應 gateway', async () => {
    const { explorer, gateway, profile } = await setup()

    await expect(explorer.listSchemas(profile.id)).resolves.toEqual(['public'])
    await expect(explorer.listTables(profile.id, 'public')).resolves.toEqual([
      { schema: 'public', name: 'orders', type: 'table' },
    ])
    await expect(explorer.describeTable(profile.id, 'public', 'orders')).resolves.toMatchObject([
      { name: 'id', primaryKey: true },
    ])
    expect(gateway.listSchemas).toHaveBeenCalledWith(expect.objectContaining({ password: 'database-secret' }))
  })

  it('資料瀏覽預設 100 列，最多 1000 列，且 offset 不得為負數', async () => {
    const { explorer, gateway, profile } = await setup()

    await explorer.readRows(profile.id, 'public', 'orders', {})
    expect(gateway.readRows).toHaveBeenCalledWith(
      expect.objectContaining({ id: profile.id }),
      { schema: 'public', table: 'orders', limit: 100, offset: 0 },
    )

    await expect(
      explorer.readRows(profile.id, 'public', 'orders', { limit: 1001 }),
    ).rejects.toEqual(new ExplorerError('INVALID_PAGE'))
    await expect(
      explorer.readRows(profile.id, 'public', 'orders', { offset: -1 }),
    ).rejects.toEqual(new ExplorerError('INVALID_PAGE'))
  })
})
