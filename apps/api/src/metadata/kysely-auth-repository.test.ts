import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { AuthError, AuthService } from '../auth/auth-service.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'
import { KyselyAuthRepository } from './kysely-auth-repository.js'

const hashOptions = { memoryCost: 8192, timeCost: 1, parallelism: 1 }
const openDatabases: Array<{ destroy(): Promise<void> }> = []
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(async (database) => database.destroy()))
  await Promise.all(tempDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })))
})

async function openSqlite(filename: string) {
  const database = createMetadataDatabase({ kind: 'sqlite', filename })
  openDatabases.push(database)
  await migrateMetadata(database)
  return database
}

function createService(repository: KyselyAuthRepository) {
  return new AuthService(repository, {
    idleTimeoutMs: 30 * 60_000,
    absoluteTimeoutMs: 12 * 60 * 60_000,
    passwordHashOptions: hashOptions,
  })
}

describe('KyselyAuthRepository with SQLite', () => {
  it('migration 可重複執行，且使用者與 session 可正常讀寫', async () => {
    const database = await openSqlite(':memory:')
    await migrateMetadata(database)
    const service = createService(new KyselyAuthRepository(database))

    await service.createUser({ username: 'admin', password: 'valid password 123', role: 'admin' })
    const login = await service.login('ADMIN', 'valid password 123')

    await expect(service.authenticate(login.token)).resolves.toMatchObject({
      username: 'admin',
      role: 'admin',
    })
  })

  it('SQLite 檔案重開後保留使用者與 session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-'))
    tempDirectories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const firstDatabase = await openSqlite(filename)
    const firstService = createService(new KyselyAuthRepository(firstDatabase))
    await firstService.createUser({
      username: 'admin',
      password: 'valid password 123',
      role: 'admin',
    })
    const login = await firstService.login('admin', 'valid password 123')
    await firstDatabase.destroy()
    openDatabases.splice(openDatabases.indexOf(firstDatabase), 1)

    const secondDatabase = await openSqlite(filename)
    const secondService = createService(new KyselyAuthRepository(secondDatabase))

    await expect(secondService.authenticate(login.token)).resolves.toMatchObject({ username: 'admin' })
  })

  it('資料庫唯一約束可阻止並行建立大小寫不同的同名帳號', async () => {
    const database = await openSqlite(':memory:')
    const service = createService(new KyselyAuthRepository(database))

    const outcomes = await Promise.allSettled([
      service.createUser({ username: 'Operator', password: 'valid password 123', role: 'user' }),
      service.createUser({ username: 'operator', password: 'another valid password', role: 'user' }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejection).toMatchObject({ reason: new AuthError('USERNAME_TAKEN') })
  })

  it('並行降權兩位可用管理員時原子保留其中一位', async () => {
    const database = await openSqlite(':memory:')
    const service = createService(new KyselyAuthRepository(database))
    const first = await service.createUser({
      username: 'first-admin',
      password: 'first admin password',
      role: 'admin',
    })
    const second = await service.createUser({
      username: 'second-admin',
      password: 'second admin password',
      role: 'admin',
    })

    const outcomes = await Promise.allSettled([
      service.setUserRole(first, first.id, 'user'),
      service.setUserRole(second, second.id, 'user'),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: new AuthError('LAST_ENABLED_ADMIN') }),
    ])
    const users = await new KyselyAuthRepository(database).listUsers()
    expect(users.filter((user) => user.enabled && user.role === 'admin')).toHaveLength(1)
  })

  it('舊版users資料表migration補齊生命週期欄位且既有帳號預設啟用', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    openDatabases.push(database)
    await database.schema
      .createTable('users')
      .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
      .addColumn('username', 'varchar(128)', (column) => column.notNull())
      .addColumn('normalized_username', 'varchar(128)', (column) => column.notNull().unique())
      .addColumn('password_hash', 'varchar(512)', (column) => column.notNull())
      .addColumn('role', 'varchar(16)', (column) => column.notNull())
      .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
      .execute()
    await database
      .insertInto('users')
      .values({
        id: 'legacy-admin',
        username: 'admin',
        normalized_username: 'admin',
        password_hash: 'legacy-hash',
        role: 'admin',
        created_at: '2026-07-31T00:00:00.000Z',
      })
      .execute()

    await migrateMetadata(database)

    await expect(new KyselyAuthRepository(database).findUserById('legacy-admin')).resolves.toMatchObject({
      enabled: true,
      passwordChangeRequired: false,
    })
  })
})
