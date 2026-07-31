import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { KyselyConnectionRepository } from './kysely-connection-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyConnectionRepository', () => {
  it('SQLite 重開後保留連線設定，資料庫檔案不含密碼明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-connections-'))
    const filename = join(directory, 'metadata.sqlite')
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 4))
    const connector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: '16' })) }
    const database = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(database)
    const service = new ConnectionService(
      new KyselyConnectionRepository(database),
      encryption,
      { postgres: connector, mysql: connector },
    )
    const created = await service.create(
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
        ssh: {
          enabled: true,
          host: 'ssh.internal',
          port: 2222,
          username: 'tunnel-user',
          password: 'ssh-secret',
        },
      },
      'admin-id',
    )
    await database.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    const reopenedRepository = new KyselyConnectionRepository(reopened)

    await expect(reopenedRepository.findById(created.id)).resolves.toMatchObject({
      id: created.id,
      ssh: {
        enabled: true,
        host: 'ssh.internal',
        port: 2222,
        username: 'tunnel-user',
      },
      encryptedSecrets: expect.stringMatching(/^v1\./),
    })
    const reopenedService = new ConnectionService(reopenedRepository, encryption, {
      postgres: connector,
      mysql: connector,
    })
    await expect(reopenedService.resolveConnection(created.id)).resolves.toMatchObject({
      ssh: { enabled: true, password: 'ssh-secret' },
    })
    await reopened.destroy()

    const contents = await import('node:fs/promises').then(async ({ readFile }) => readFile(filename))
    expect(contents.includes(Buffer.from('database-secret'))).toBe(false)
    expect(contents.includes(Buffer.from('ssh-secret'))).toBe(false)
    await rm(directory, { recursive: true })
  })
})
