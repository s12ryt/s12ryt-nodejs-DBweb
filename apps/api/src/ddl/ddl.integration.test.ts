import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { detectDdlCapabilities, type DdlCapabilities } from './ddl-capabilities.js'
import type { DdlCommand } from './ddl-command.js'
import { buildDdlStatements } from './ddl-sql-builder.js'
import { MysqlDdlGateway } from './mysql-ddl-gateway.js'
import { PostgresDdlGateway } from './postgres-ddl-gateway.js'
import type { DdlGateway } from './ddl-service.js'

const engine = process.env.DBWEB_INTEGRATION_ENGINE
const host = process.env.DBWEB_INTEGRATION_HOST ?? '127.0.0.1'
const port = Number(process.env.DBWEB_INTEGRATION_PORT ?? (engine === 'mysql' ? 3306 : 5432))
const database = process.env.DBWEB_INTEGRATION_DATABASE ?? 'dbweb'
const username = process.env.DBWEB_INTEGRATION_USERNAME ?? 'dbweb'
const password = process.env.DBWEB_INTEGRATION_PASSWORD ?? 'dbweb-test-password'

const connection: ResolvedConnection = {
  id: 'ddl-integration',
  name: 'DDL integration database',
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

describe.runIf(engine === 'postgres')('PostgreSQL DDL integration', () => {
  const gateway = new PostgresDdlGateway()
  const schema = 'public'

  it('executes version-aware table, column, index, and constraint DDL transactionally', async () => {
    const capabilities = await liveCapabilities(gateway)
    expect(capabilities.engine).toBe('postgres')
    await postgresQuery('DROP TABLE IF EXISTS dbweb_ddl_test')
    await postgresQuery('DROP TABLE IF EXISTS dbweb_ddl_rollback')
    try {
      await run(gateway, capabilities, {
        kind: 'create-table', schema, name: 'dbweb_ddl_test',
        columns: [
          { name: 'id', type: { name: 'integer' }, nullable: false },
          { name: 'code', type: { name: 'varchar', length: 50 }, nullable: false },
        ],
      })
      await run(gateway, capabilities, {
        kind: 'add-column', schema, table: 'dbweb_ddl_test',
        column: { name: 'total', type: { name: 'numeric', precision: 12, scale: 2 }, nullable: true },
      })
      await run(gateway, capabilities, {
        kind: 'rename-column', schema, table: 'dbweb_ddl_test', from: 'total', to: 'amount',
      })
      await run(gateway, capabilities, {
        kind: 'create-index', schema, table: 'dbweb_ddl_test', name: 'dbweb_ddl_code_idx',
        method: 'btree', unique: false, parts: [{ column: 'code' }], confirmed: false,
      })
      await run(gateway, capabilities, {
        kind: 'add-constraint', schema, table: 'dbweb_ddl_test', name: 'dbweb_ddl_code_key',
        constraint: { kind: 'unique', columns: ['code'] }, confirmed: false,
      })
      await run(gateway, capabilities, {
        kind: 'add-constraint', schema, table: 'dbweb_ddl_test', name: 'dbweb_ddl_amount_check',
        constraint: { kind: 'check', expression: 'amount >= 0' }, confirmed: true,
      })

      expect(await postgresQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dbweb_ddl_test' ORDER BY ordinal_position"))
        .toEqual([{ column_name: 'id' }, { column_name: 'code' }, { column_name: 'amount' }])
      expect(await postgresQuery("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'dbweb_ddl_test' ORDER BY indexname"))
        .toEqual(expect.arrayContaining([{ indexname: 'dbweb_ddl_code_idx' }, { indexname: 'dbweb_ddl_code_key' }]))

      await expect(gateway.execute(connection, [
        'CREATE TABLE "public"."dbweb_ddl_rollback" ("id" integer)',
        'THIS IS NOT VALID SQL',
      ], { transactional: true })).rejects.toMatchObject({ code: 'DDL_FAILED' })
      expect(await postgresQuery("SELECT to_regclass('public.dbweb_ddl_rollback') AS relation"))
        .toEqual([{ relation: null }])
    } finally {
      await postgresQuery('DROP TABLE IF EXISTS dbweb_ddl_rollback')
      await postgresQuery('DROP TABLE IF EXISTS dbweb_ddl_test')
    }
  }, 30_000)
})

describe.runIf(engine === 'mysql')('MySQL DDL integration', () => {
  const gateway = new MysqlDdlGateway()

  it('executes version-aware nontransactional table, column, index, and constraint DDL', async () => {
    const capabilities = await liveCapabilities(gateway)
    expect(capabilities.engine).toBe('mysql')
    await mysqlQuery('DROP TABLE IF EXISTS dbweb_ddl_test')
    try {
      await run(gateway, capabilities, {
        kind: 'create-table', schema: database, name: 'dbweb_ddl_test', engine: 'InnoDB',
        columns: [
          { name: 'id', type: { name: 'int' }, nullable: false, identity: true },
          { name: 'code', type: { name: 'varchar', length: 50 }, nullable: false },
        ],
        primaryKey: ['id'],
      })
      await run(gateway, capabilities, {
        kind: 'add-column', schema: database, table: 'dbweb_ddl_test',
        column: { name: 'total', type: { name: 'decimal', precision: 12, scale: 2 }, nullable: true },
      })
      await run(gateway, capabilities, {
        kind: 'rename-column', schema: database, table: 'dbweb_ddl_test', from: 'total', to: 'amount',
        ...(capabilities.column.renameSyntax === 'change-column'
          ? { definition: { name: 'amount', type: { name: 'decimal', precision: 12, scale: 2 }, nullable: true } }
          : {}),
      })
      await run(gateway, capabilities, {
        kind: 'create-index', schema: database, table: 'dbweb_ddl_test', name: 'dbweb_ddl_code_idx',
        method: 'btree', unique: false, parts: [{ column: 'code' }], confirmed: false,
      })
      await run(gateway, capabilities, {
        kind: 'add-constraint', schema: database, table: 'dbweb_ddl_test', name: 'dbweb_ddl_code_key',
        constraint: { kind: 'unique', columns: ['code'] }, confirmed: false,
      })
      if (capabilities.constraint.check) {
        await run(gateway, capabilities, {
          kind: 'add-constraint', schema: database, table: 'dbweb_ddl_test', name: 'dbweb_ddl_amount_check',
          constraint: { kind: 'check', expression: 'amount >= 0' }, confirmed: true,
        })
      }

      expect(await mysqlQuery("SELECT COLUMN_NAME AS dbweb_column FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dbweb_ddl_test' ORDER BY ORDINAL_POSITION"))
        .toEqual([{ dbweb_column: 'id' }, { dbweb_column: 'code' }, { dbweb_column: 'amount' }])
      expect(await mysqlQuery("SELECT DISTINCT INDEX_NAME AS dbweb_index FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'dbweb_ddl_test' ORDER BY INDEX_NAME"))
        .toEqual(expect.arrayContaining([{ dbweb_index: 'dbweb_ddl_code_idx' }, { dbweb_index: 'dbweb_ddl_code_key' }]))
    } finally {
      await mysqlQuery('DROP TABLE IF EXISTS dbweb_ddl_test')
    }
  }, 30_000)
})

async function liveCapabilities(gateway: DdlGateway): Promise<DdlCapabilities> {
  return detectDdlCapabilities(connection.engine, await gateway.serverVersion(connection))
}

async function run(gateway: DdlGateway, capabilities: DdlCapabilities, command: DdlCommand): Promise<void> {
  await gateway.execute(connection, buildDdlStatements(capabilities, command), {
    transactional: capabilities.transactionalDdl && !command.kind.endsWith('-database'),
  })
}

async function postgresQuery(sql: string): Promise<Array<Record<string, unknown>>> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try { return (await client.query(sql)).rows as Array<Record<string, unknown>> }
  finally { await client.end() }
}

async function mysqlQuery(sql: string): Promise<Array<Record<string, unknown>>> {
  const client = await mysql.createConnection({ host, port, database, user: username, password })
  try {
    const [rows] = await client.query(sql)
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
  } finally { await client.end() }
}
