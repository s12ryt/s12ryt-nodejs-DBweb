import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { MysqlNativeAccountGateway } from './mysql-native-account-gateway.js'
import { PostgresNativeAccountGateway } from './postgres-native-account-gateway.js'

const engine = process.env.DBWEB_INTEGRATION_ENGINE
const host = process.env.DBWEB_INTEGRATION_HOST ?? '127.0.0.1'
const port = Number(process.env.DBWEB_INTEGRATION_PORT ?? (engine === 'mysql' ? 3306 : 5432))
const database = process.env.DBWEB_INTEGRATION_DATABASE ?? 'dbweb'
const username = process.env.DBWEB_INTEGRATION_USERNAME ?? 'dbweb'
const password = process.env.DBWEB_INTEGRATION_PASSWORD ?? 'dbweb-test-password'
const adminPassword = process.env.DBWEB_INTEGRATION_ADMIN_PASSWORD

const connection: ResolvedConnection = {
  id: 'native-account-integration',
  name: 'Native account integration database',
  engine: engine === 'mysql' ? 'mysql' : 'postgres',
  host,
  port,
  database,
  username,
  password,
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

describe.runIf(engine === 'postgres')('PostgreSQL native account integration', () => {
  const gateway = new PostgresNativeAccountGateway()
  const identity = { engine: 'postgres' as const, username: 'dbweb_native_test' }
  const initialPassword = 'dbweb-native-initial-password'
  const rotatedPassword = 'dbweb-native-rotated-password'

  it('creates, rotates, disables, enables, verifies, and deletes a restricted role', async () => {
    await postgresQuery('DROP ROLE IF EXISTS dbweb_native_test')
    try {
      await gateway.createAccount(connection, {
        identity,
        password: initialPassword,
        canLogin: true,
        connectionLimit: 2,
      })
      expect(await gateway.listAccounts(connection)).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity, canLogin: true, connectionLimit: 2, systemAccount: false }),
      ]))
      await gateway.verifyCredential(connection, database, identity, initialPassword)

      await gateway.rotatePassword(connection, identity, rotatedPassword)
      await expect(gateway.verifyCredential(connection, database, identity, initialPassword))
        .rejects.toMatchObject({ code: 'NATIVE_ACCOUNT_FAILED' })
      await gateway.verifyCredential(connection, database, identity, rotatedPassword)

      await gateway.setAccountEnabled(connection, identity, false, rotatedPassword)
      await expect(gateway.verifyCredential(connection, database, identity, rotatedPassword))
        .rejects.toMatchObject({ code: 'NATIVE_ACCOUNT_FAILED' })
      await gateway.setAccountEnabled(connection, identity, true, rotatedPassword)
      await gateway.verifyCredential(connection, database, identity, rotatedPassword)

      await gateway.deleteAccount(connection, identity)
      expect((await gateway.listAccounts(connection)).some((account) =>
        account.identity.engine === 'postgres' && account.identity.username === identity.username,
      )).toBe(false)
    } finally {
      await postgresQuery('DROP ROLE IF EXISTS dbweb_native_test')
    }
  }, 30_000)
})

describe.runIf(engine === 'mysql')('MySQL native account integration', () => {
  const gateway = new MysqlNativeAccountGateway()
  const identity = { engine: 'mysql' as const, username: 'dbweb_nat_test', host: '%' }
  const initialPassword = 'dbweb-native-initial-password'
  const rotatedPassword = 'dbweb-native-rotated-password'

  it('creates, rotates, disables, enables, verifies, and deletes a restricted account', async () => {
    await dropMysqlTestAccount()
    try {
      try {
        await gateway.createAccount(connection, {
          identity,
          password: initialPassword,
          canLogin: true,
          connectionLimit: 2,
        })
      } catch (error) {
        const rows = await mysqlAdminQuery(
          "SELECT User AS dbweb_user, max_user_connections AS dbweb_limit FROM mysql.user WHERE User = 'dbweb_nat_test' AND Host = '%'",
        )
        throw new Error(JSON.stringify({ accountStateAfterFailure: rows }), { cause: error })
      }
      await mysqlAdminQuery(`GRANT SELECT ON \`${database.replaceAll('`', '``')}\`.* TO 'dbweb_nat_test'@'%'`)
      expect(await gateway.listAccounts(connection)).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity, canLogin: true, connectionLimit: 2, systemAccount: false }),
      ]))
      await gateway.verifyCredential(connection, database, identity, initialPassword)

      await gateway.rotatePassword(connection, identity, rotatedPassword)
      await expect(gateway.verifyCredential(connection, database, identity, initialPassword))
        .rejects.toMatchObject({ code: 'NATIVE_ACCOUNT_FAILED' })
      await gateway.verifyCredential(connection, database, identity, rotatedPassword)

      await gateway.setAccountEnabled(connection, identity, false, rotatedPassword)
      await expect(gateway.verifyCredential(connection, database, identity, rotatedPassword))
        .rejects.toMatchObject({ code: 'NATIVE_ACCOUNT_FAILED' })
      await gateway.setAccountEnabled(connection, identity, true, rotatedPassword)
      await gateway.verifyCredential(connection, database, identity, rotatedPassword)

      await gateway.deleteAccount(connection, identity)
      expect((await gateway.listAccounts(connection)).some((account) =>
        account.identity.engine === 'mysql' &&
        account.identity.username === identity.username &&
        account.identity.host === identity.host,
      )).toBe(false)
    } finally {
      await dropMysqlTestAccount()
    }
  }, 30_000)
})

async function postgresQuery(sql: string): Promise<void> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try { await client.query(sql) }
  finally { await client.end() }
}

async function mysqlAdminQuery(sql: string): Promise<Array<Record<string, unknown>>> {
  if (!adminPassword) throw new Error('DBWEB_INTEGRATION_ADMIN_PASSWORD is required')
  const client = await mysql.createConnection({ host, port, user: 'root', password: adminPassword })
  try {
    const [rows] = await client.query(sql)
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
  } finally { await client.end() }
}

async function dropMysqlTestAccount(): Promise<void> {
  const rows = await mysqlAdminQuery(
    "SELECT COUNT(*) AS dbweb_count FROM mysql.user WHERE User = 'dbweb_nat_test' AND Host = '%'",
  )
  if (Number(rows[0]?.dbweb_count) > 0) {
    await mysqlAdminQuery("DROP USER 'dbweb_nat_test'@'%'")
  }
}
