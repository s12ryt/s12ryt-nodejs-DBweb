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

  it('manages supported advanced and programmable objects', async () => {
    const capabilities = await liveCapabilities(gateway)
    await cleanupPostgresAdvancedObjects(capabilities)
    try {
      await postgresQuery('CREATE TABLE dbweb_advanced_source (id integer NOT NULL, code text NOT NULL)')
      await postgresQuery("CREATE FUNCTION dbweb_trigger_function() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.code := upper(NEW.code); RETURN NEW; END; $$")

      await run(gateway, capabilities, {
        kind: 'create-view', schema, name: 'dbweb_advanced_view',
        query: 'SELECT id, code FROM public.dbweb_advanced_source', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-materialized-view', schema, name: 'dbweb_advanced_materialized',
        query: 'SELECT count(*) AS total FROM public.dbweb_advanced_source', withData: true, confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'refresh-materialized-view', schema, name: 'dbweb_advanced_materialized', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-sequence', schema, name: 'dbweb_advanced_sequence', start: 10, increment: 2,
      })
      await run(gateway, capabilities, {
        kind: 'create-enum', schema, name: 'dbweb_advanced_state', values: ['new', 'done'],
      })
      await run(gateway, capabilities, {
        kind: 'create-domain', schema, name: 'dbweb_positive_integer', baseType: { name: 'integer' },
        nullable: false, check: 'VALUE > 0', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-routine', routineKind: 'function', schema, name: 'dbweb_mask_value',
        arguments: [{ name: 'input', type: { name: 'text' } }], returns: { name: 'text' },
        language: 'sql', body: "SELECT 'masked'::text", confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-trigger', schema, table: 'dbweb_advanced_source', name: 'dbweb_advanced_trigger',
        timing: 'before', events: ['insert'], forEach: 'row',
        functionSchema: schema, functionName: 'dbweb_trigger_function', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-extension', name: 'pgcrypto', confirmed: true,
      })

      if (capabilities.advanced.procedure) {
        await run(gateway, capabilities, {
          kind: 'create-routine', routineKind: 'procedure', schema, name: 'dbweb_noop_procedure',
          arguments: [], language: 'plpgsql', body: 'BEGIN NULL; END;', confirmed: true,
        })
      }
      if (capabilities.advanced.partition) {
        await postgresQuery('CREATE TABLE dbweb_partitioned_events (id integer NOT NULL) PARTITION BY RANGE (id)')
        await run(gateway, capabilities, {
          kind: 'create-partition', schema, table: 'dbweb_partitioned_events', name: 'dbweb_events_low',
          definition: 'FOR VALUES FROM (0) TO (100)', confirmed: true,
        })
      }

      expect(await postgresQuery("SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'dbweb_advanced_view'"))
        .toEqual([{ table_name: 'dbweb_advanced_view' }])
      expect(await postgresQuery("SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'dbweb_advanced_materialized'"))
        .toEqual([{ matviewname: 'dbweb_advanced_materialized' }])
      expect(await postgresQuery("SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'dbweb_mask_value'"))
        .toEqual([{ routine_name: 'dbweb_mask_value' }])
      expect(await postgresQuery("SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = 'public' AND trigger_name = 'dbweb_advanced_trigger'"))
        .toEqual([{ trigger_name: 'dbweb_advanced_trigger' }])
      expect(await postgresQuery("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'"))
        .toEqual([{ extname: 'pgcrypto' }])
      if (capabilities.advanced.procedure) {
        expect(await postgresQuery("SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'dbweb_noop_procedure'"))
          .toEqual([{ routine_name: 'dbweb_noop_procedure' }])
      }
      if (capabilities.advanced.partition) {
        expect(await postgresQuery("SELECT to_regclass('public.dbweb_events_low') AS relation"))
          .toEqual([{ relation: 'dbweb_events_low' }])
      }
    } finally {
      await cleanupPostgresAdvancedObjects(capabilities)
    }
  }, 60_000)
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

  it('manages supported advanced and programmable objects', async () => {
    const capabilities = await liveCapabilities(gateway)
    await cleanupMysqlAdvancedObjects()
    try {
      await mysqlQuery('CREATE TABLE dbweb_advanced_source (id int NOT NULL PRIMARY KEY, code varchar(50) NOT NULL, marker varchar(50) NULL) ENGINE=InnoDB')
      await mysqlQuery('CREATE TABLE dbweb_partitioned_events (id int NOT NULL) ENGINE=InnoDB PARTITION BY RANGE (id) (PARTITION dbweb_events_base VALUES LESS THAN (100))')

      await run(gateway, capabilities, {
        kind: 'create-view', schema: database, name: 'dbweb_advanced_view',
        query: `SELECT id, code FROM \`${database}\`.\`dbweb_advanced_source\``, confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-routine', routineKind: 'function', schema: database, name: 'dbweb_constant_value',
        arguments: [], returns: { name: 'int' }, body: 'RETURN 7',
        deterministic: true, dataAccess: 'no-sql', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-routine', routineKind: 'procedure', schema: database, name: 'dbweb_noop_procedure',
        arguments: [], body: 'SELECT 1', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-trigger', schema: database, table: 'dbweb_advanced_source', name: 'dbweb_advanced_trigger',
        timing: 'before', events: ['insert'], forEach: 'row', body: 'SET NEW.marker = UPPER(NEW.code)', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-event', schema: database, name: 'dbweb_advanced_event',
        schedule: { kind: 'every', amount: 1, unit: 'day' }, preserve: true, enabled: false,
        body: 'DELETE FROM dbweb_advanced_source WHERE id < 0', confirmed: true,
      })
      await run(gateway, capabilities, {
        kind: 'create-partition', schema: database, table: 'dbweb_partitioned_events', name: 'dbweb_events_high',
        definition: 'VALUES LESS THAN (200)', confirmed: true,
      })

      expect(await mysqlQuery("SELECT TABLE_NAME AS dbweb_name FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = 'dbweb_advanced_view'"))
        .toEqual([{ dbweb_name: 'dbweb_advanced_view' }])
      expect(await mysqlQuery("SELECT ROUTINE_NAME AS dbweb_name FROM information_schema.routines WHERE routine_schema = DATABASE() AND routine_name IN ('dbweb_constant_value', 'dbweb_noop_procedure') ORDER BY routine_name"))
        .toEqual([{ dbweb_name: 'dbweb_constant_value' }, { dbweb_name: 'dbweb_noop_procedure' }])
      expect(await mysqlQuery("SELECT TRIGGER_NAME AS dbweb_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = 'dbweb_advanced_trigger'"))
        .toEqual([{ dbweb_name: 'dbweb_advanced_trigger' }])
      expect(await mysqlQuery("SELECT EVENT_NAME AS dbweb_name FROM information_schema.events WHERE event_schema = DATABASE() AND event_name = 'dbweb_advanced_event'"))
        .toEqual([{ dbweb_name: 'dbweb_advanced_event' }])
      expect(await mysqlQuery("SELECT DISTINCT PARTITION_NAME AS dbweb_name FROM information_schema.partitions WHERE table_schema = DATABASE() AND table_name = 'dbweb_partitioned_events' AND partition_name = 'dbweb_events_high'"))
        .toEqual([{ dbweb_name: 'dbweb_events_high' }])
    } finally {
      await cleanupMysqlAdvancedObjects()
    }
  }, 60_000)
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

async function cleanupPostgresAdvancedObjects(capabilities: DdlCapabilities): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS dbweb_partitioned_events CASCADE',
    'DROP TABLE IF EXISTS dbweb_advanced_source CASCADE',
    'DROP MATERIALIZED VIEW IF EXISTS dbweb_advanced_materialized CASCADE',
    'DROP VIEW IF EXISTS dbweb_advanced_view CASCADE',
    ...(capabilities.advanced.procedure ? ['DROP PROCEDURE IF EXISTS dbweb_noop_procedure()'] : []),
    'DROP FUNCTION IF EXISTS dbweb_mask_value(text)',
    'DROP FUNCTION IF EXISTS dbweb_trigger_function()',
    'DROP DOMAIN IF EXISTS dbweb_positive_integer CASCADE',
    'DROP TYPE IF EXISTS dbweb_advanced_state CASCADE',
    'DROP SEQUENCE IF EXISTS dbweb_advanced_sequence CASCADE',
    'DROP EXTENSION IF EXISTS pgcrypto CASCADE',
  ]
  for (const statement of statements) await postgresQuery(statement)
}

async function cleanupMysqlAdvancedObjects(): Promise<void> {
  const statements = [
    'DROP EVENT IF EXISTS dbweb_advanced_event',
    'DROP TRIGGER IF EXISTS dbweb_advanced_trigger',
    'DROP PROCEDURE IF EXISTS dbweb_noop_procedure',
    'DROP FUNCTION IF EXISTS dbweb_constant_value',
    'DROP VIEW IF EXISTS dbweb_advanced_view',
    'DROP TABLE IF EXISTS dbweb_partitioned_events',
    'DROP TABLE IF EXISTS dbweb_advanced_source',
  ]
  for (const statement of statements) await mysqlQuery(statement)
}
