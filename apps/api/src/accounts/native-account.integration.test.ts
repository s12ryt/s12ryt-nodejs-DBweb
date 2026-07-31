import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { MysqlNativeAccountGateway } from './mysql-native-account-gateway.js'
import { MysqlNativeGrantGateway } from './mysql-native-grant-gateway.js'
import { buildNativeGrantPlan } from './native-grant-plan.js'
import { PostgresNativeAccountGateway } from './postgres-native-account-gateway.js'
import { PostgresNativeGrantGateway } from './postgres-native-grant-gateway.js'

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

  it('reads actual grants and rolls back a failed grant batch', async () => {
    const grants = new PostgresNativeGrantGateway()
    await postgresQuery('DROP TABLE IF EXISTS public.dbweb_grant_test')
    await postgresQuery('DROP ROLE IF EXISTS dbweb_native_test')
    try {
      await gateway.createAccount(connection, { identity, password: initialPassword, canLogin: true, connectionLimit: 2 })
      await postgresQuery('CREATE TABLE public.dbweb_grant_test (id integer PRIMARY KEY)')
      const plan = buildNativeGrantPlan('postgres', {
        kind: 'grant', identity,
        changes: [{ scope: 'table', database, schema: 'public', table: 'dbweb_grant_test', privileges: ['select'] }],
      })
      await grants.execute(connection, database, plan.statements)
      expect(await grants.listGrants(connection, database, identity)).toEqual(expect.arrayContaining([
        { scope: 'table', database, schema: 'public', table: 'dbweb_grant_test', privileges: ['select'] },
      ]))

      const revoke = buildNativeGrantPlan('postgres', {
        kind: 'revoke', identity, confirmed: true,
        changes: [{ scope: 'table', database, schema: 'public', table: 'dbweb_grant_test', privileges: ['select'] }],
      })
      await grants.execute(connection, database, revoke.statements)
      await expect(grants.execute(connection, database, [
        plan.statements[0]!,
        'GRANT SELECT ON TABLE "public"."dbweb_missing_table" TO "dbweb_native_test"',
      ])).rejects.toMatchObject({ code: 'NATIVE_GRANT_FAILED', appliedCount: 0, failedIndex: 1 })
      expect(await grants.listGrants(connection, database, identity)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ scope: 'table', table: 'dbweb_grant_test', privileges: expect.arrayContaining(['select']) }),
      ]))
    } finally {
      await postgresQuery('DROP TABLE IF EXISTS public.dbweb_grant_test')
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
      await gateway.createAccount(connection, {
        identity,
        password: initialPassword,
        canLogin: true,
        connectionLimit: 2,
      })
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

  it('reads actual grants and preserves completed MySQL grant steps on failure', async () => {
    const grants = new MysqlNativeGrantGateway()
    await dropMysqlTestAccount()
    await mysqlQuery('DROP TABLE IF EXISTS `dbweb_grant_test`')
    try {
      await gateway.createAccount(connection, { identity, password: initialPassword, canLogin: true, connectionLimit: 2 })
      await mysqlQuery('CREATE TABLE `dbweb_grant_test` (`id` integer PRIMARY KEY)')
      const plan = buildNativeGrantPlan('mysql', {
        kind: 'grant', identity,
        changes: [{ scope: 'table', database, table: 'dbweb_grant_test', privileges: ['select'] }],
      })
      await grants.execute(connection, database, plan.statements)
      expect(await grants.listGrants(connection, database, identity)).toEqual(expect.arrayContaining([
        { scope: 'table', database, table: 'dbweb_grant_test', privileges: ['select'] },
      ]))

      const revoke = buildNativeGrantPlan('mysql', {
        kind: 'revoke', identity, confirmed: true,
        changes: [{ scope: 'table', database, table: 'dbweb_grant_test', privileges: ['select'] }],
      })
      await grants.execute(connection, database, revoke.statements)
      await expect(grants.execute(connection, database, [
        plan.statements[0]!,
        `GRANT SELECT ON \`${database}\`.\`dbweb_missing_table\` TO 'dbweb_nat_test'@'%'`,
      ])).rejects.toMatchObject({ code: 'NATIVE_GRANT_FAILED', appliedCount: 1, failedIndex: 1 })
      expect(await grants.listGrants(connection, database, identity)).toEqual(expect.arrayContaining([
        { scope: 'table', database, table: 'dbweb_grant_test', privileges: ['select'] },
      ]))
    } finally {
      await mysqlQuery('DROP TABLE IF EXISTS `dbweb_grant_test`')
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

async function mysqlQuery(sql: string): Promise<void> {
  const client = await mysql.createConnection({ host, port, database, user: username, password })
  try { await client.query(sql) }
  finally { await client.end() }
}

async function dropMysqlTestAccount(): Promise<void> {
  const rows = await mysqlAdminQuery(
    "SELECT COUNT(*) AS dbweb_count FROM mysql.user WHERE User = 'dbweb_nat_test' AND Host = '%'",
  )
  if (Number(rows[0]?.dbweb_count) > 0) {
    await mysqlAdminQuery("DROP USER 'dbweb_nat_test'@'%'")
  }
}
