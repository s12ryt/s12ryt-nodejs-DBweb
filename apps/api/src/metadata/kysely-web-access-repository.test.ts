import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'
import { KyselyWebAccessRepository } from './kysely-web-access-repository.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })))
})

describe('KyselyWebAccessRepository', () => {
  it('持久化並原子取代每個user/connection的能力，且不替既有使用者自動分配', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-access-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const database = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(database)
    await seedUserAndConnection(database)
    const repository = new KyselyWebAccessRepository(database)

    expect(await repository.listByUser('user-1')).toEqual([])

    await repository.replace({
      userId: 'user-1',
      connectionId: 'connection-1',
      capabilities: ['structure-read', 'data-read', 'query-read'],
    })
    await repository.replace({
      userId: 'user-1',
      connectionId: 'connection-1',
      capabilities: ['structure-read', 'ddl-write'],
    })
    await database.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    const reopenedRepository = new KyselyWebAccessRepository(reopened)
    expect(await reopenedRepository.find('user-1', 'connection-1')).toEqual({
      userId: 'user-1',
      connectionId: 'connection-1',
      capabilities: ['structure-read', 'ddl-write'],
    })
    await reopened.destroy()
  })

  it('刪除使用者或connection時級聯清除授權', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    await seedUserAndConnection(database)
    const repository = new KyselyWebAccessRepository(database)
    await repository.replace({
      userId: 'user-1',
      connectionId: 'connection-1',
      capabilities: ['structure-read'],
    })

    await database.deleteFrom('users').where('id', '=', 'user-1').execute()

    expect(await repository.find('user-1', 'connection-1')).toBeUndefined()
    await database.destroy()
  })
})

async function seedUserAndConnection(
  database: ReturnType<typeof createMetadataDatabase>,
): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id: 'user-1',
      username: 'operator',
      normalized_username: 'operator',
      password_hash: 'hash',
      role: 'user',
      created_at: new Date(0).toISOString(),
    })
    .execute()
  await database
    .insertInto('connections')
    .values({
      id: 'connection-1',
      name: 'Primary',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database_name: 'app',
      username: 'dbweb',
      tls_mode: 'disable',
      tls_has_ca: 0,
      tls_has_client_certificate: 0,
      keepalive_enabled: 0,
      keepalive_interval_ms: 300_000,
      ssh_enabled: 0,
      ssh_host: null,
      ssh_port: null,
      ssh_username: null,
      created_by: 'admin-1',
      created_at: new Date(0).toISOString(),
      encrypted_secrets: 'ciphertext',
    })
    .execute()
}
