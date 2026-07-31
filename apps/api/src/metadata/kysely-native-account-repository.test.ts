import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NativeAccountCredentialVault } from '../accounts/native-account-credential.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { KyselyNativeAccountRepository } from './kysely-native-account-repository.js'
import { createMetadataDatabase, migrateMetadata, type MetadataKysely } from './metadata-database.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })))
})

describe('KyselyNativeAccountRepository', () => {
  it('persists managed identity and encrypted credentials across SQLite restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-native-accounts-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const database = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(database)
    await seedConnection(database)
    const vault = new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 9)))
    const sealed = vault.seal('account-1', 'native-password-secret')
    const repository = new KyselyNativeAccountRepository(database)

    await repository.save({
      id: 'account-1',
      connectionId: 'connection-1',
      identity: { engine: 'mysql', username: 'reporter', host: '10.%' },
      encryptedPassword: sealed.encryptedPassword,
      verificationDatabase: 'analytics',
      verificationIntervalMs: 21_600_000,
      canLogin: true,
      connectionLimit: 4,
      status: 'active',
      verificationFailures: 0,
      nextVerificationAt: '2026-07-31T06:00:00.000Z',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    })
    await database.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    const stored = await new KyselyNativeAccountRepository(reopened).findByIdentity(
      'connection-1',
      { engine: 'mysql', username: 'reporter', host: '10.%' },
    )
    expect(stored).toMatchObject({
      id: 'account-1',
      identity: { engine: 'mysql', username: 'reporter', host: '10.%' },
      verificationDatabase: 'analytics',
      verificationIntervalMs: 21_600_000,
      status: 'active',
      encryptedPassword: expect.stringMatching(/^v1\./),
    })
    expect(vault.reveal('account-1', stored!.encryptedPassword)).toBe('native-password-secret')
    await reopened.destroy()

    expect((await readFile(filename)).includes(Buffer.from('native-password-secret'))).toBe(false)
  })

  it('removes managed metadata when its connection is deleted', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    await seedConnection(database)
    const repository = new KyselyNativeAccountRepository(database)
    await repository.save({
      id: 'account-1', connectionId: 'connection-1',
      identity: { engine: 'postgres', username: 'reporter' },
      encryptedPassword: 'ciphertext', verificationDatabase: 'app',
      verificationIntervalMs: 21_600_000, canLogin: true, connectionLimit: 4, status: 'active',
      verificationFailures: 0, nextVerificationAt: '2026-07-31T06:00:00.000Z',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    })

    await database.deleteFrom('connections').where('id', '=', 'connection-1').execute()
    expect(await repository.listByConnection('connection-1')).toEqual([])
    await database.destroy()
  })

  it('deletes expired recovery metadata including its encrypted password', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    await migrateMetadata(database)
    await seedConnection(database)
    const repository = new KyselyNativeAccountRepository(database)
    await repository.save({
      id: 'expired', connectionId: 'connection-1',
      identity: { engine: 'postgres', username: 'expired_user' },
      encryptedPassword: 'sensitive-ciphertext', verificationDatabase: 'app',
      verificationIntervalMs: 21_600_000, canLogin: false, connectionLimit: -1,
      status: 'deleted', verificationFailures: 0,
      nextVerificationAt: '2026-07-01T00:00:00.000Z',
      deletedAt: '2026-07-01T00:00:00.000Z', recoverUntil: '2026-07-15T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    })

    expect(await repository.deleteExpiredRecovery('2026-07-15T00:00:00.000Z')).toBe(1)
    expect(await repository.findById('expired')).toBeUndefined()
    await database.destroy()
  })
})

async function seedConnection(database: MetadataKysely): Promise<void> {
  await database.insertInto('connections').values({
    id: 'connection-1', name: 'Primary', engine: 'mysql', host: 'localhost', port: 3306,
    database_name: 'app', username: 'dbweb', tls_mode: 'disable', tls_has_ca: 0,
    tls_has_client_certificate: 0, keepalive_enabled: 0, keepalive_interval_ms: 300_000,
    ssh_enabled: 0, ssh_host: null, ssh_port: null, ssh_username: null,
    created_by: 'admin-1', created_at: new Date(0).toISOString(), encrypted_secrets: 'ciphertext',
  }).execute()
}
