import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  KyselySshHostKeyResetRecorder,
  KyselySshKnownHostRepository,
} from './kysely-ssh-known-host-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselySshKnownHostRepository', () => {
  it('原子固定單一 fingerprint，並在 SQLite 重開後保留', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-known-hosts-'))
    const filename = join(directory, 'metadata.sqlite')
    const endpoint = '[ssh.internal]:22'
    const database = createMetadataDatabase({ kind: 'sqlite', filename })

    try {
      await migrateMetadata(database)
      const repository = new KyselySshKnownHostRepository(database)
      const results = await Promise.all([
        repository.claim(endpoint, 'sha256:first'),
        repository.claim(endpoint, 'sha256:second'),
      ])

      expect(results.sort()).toEqual(['claimed', 'conflict'])
      expect(await repository.find(endpoint)).toMatchObject({
        endpoint,
        fingerprint: expect.stringMatching(/^sha256:(first|second)$/),
      })
    } finally {
      await database.destroy()
    }

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    try {
      await migrateMetadata(reopened)
      await expect(new KyselySshKnownHostRepository(reopened).find(endpoint)).resolves.toMatchObject({
        endpoint,
        fingerprint: expect.stringMatching(/^sha256:(first|second)$/),
      })
    } finally {
      await reopened.destroy()
      await rm(directory, { recursive: true })
    }
  })

  it('刪除 pin 並持久化不含 host key 的 reset audit', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    try {
      await migrateMetadata(database)
      const repository = new KyselySshKnownHostRepository(database)
      const recorder = new KyselySshHostKeyResetRecorder(database)
      await repository.claim('[ssh.internal]:22', 'sha256:sensitive')

      await repository.delete('[ssh.internal]:22')
      await recorder.record({
        actorId: 'admin-1',
        endpoint: '[ssh.internal]:22',
        createdAt: '2026-07-31T00:00:00.000Z',
      })

      await expect(repository.find('[ssh.internal]:22')).resolves.toBeUndefined()
      const events = await recorder.list()
      expect(events).toEqual([{
        actorId: 'admin-1',
        endpoint: '[ssh.internal]:22',
        createdAt: '2026-07-31T00:00:00.000Z',
      }])
      expect(JSON.stringify(events)).not.toContain('sha256:')
    } finally {
      await database.destroy()
    }
  })
})
