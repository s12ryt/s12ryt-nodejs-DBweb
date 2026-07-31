import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { buildDdlStatements } from '../ddl/ddl-sql-builder.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { MysqlSqlDumpSnapshotSessionFactory } from './mysql-sql-dump-snapshot.js'
import { MysqlSqlRestoreGateway } from './mysql-sql-restore-gateway.js'
import { loadMysqlSqlDumpData } from './mysql-sql-restore-data-loader.js'
import { PostgresSqlDumpSnapshotSessionFactory } from './postgres-sql-dump-snapshot.js'
import { PostgresSqlRestoreGateway } from './postgres-sql-restore-gateway.js'
import { loadPostgresSqlDumpData } from './postgres-sql-restore-data-loader.js'
import type { SqlDumpManifest, SqlDumpObjectKind } from './sql-dump-manifest.js'
import { readSqlDumpPackage } from './sql-dump-package.js'
import { SqlDumpPackageWriter } from './sql-dump-package-writer.js'
import type { SqlDumpExportPlan } from './sql-dump-export-service.js'
import { SqlDumpSnapshotCatalog, type SqlDumpSnapshotSessionFactory } from './sql-dump-snapshot-catalog.js'
import type { SqlRestoreExecutionGateway, SqlRestoreSession } from './sql-restore-service.js'
import { buildSqlRestorePlan, type SqlRestoreStep } from './sql-restore-plan.js'
import { TransferOutputWriter } from './transfer-output-writer.js'

const engine = process.env.DBWEB_INTEGRATION_ENGINE
const host = process.env.DBWEB_INTEGRATION_HOST ?? '127.0.0.1'
const port = Number(process.env.DBWEB_INTEGRATION_PORT ?? (engine === 'mysql' ? 3306 : 5432))
const database = process.env.DBWEB_INTEGRATION_DATABASE ?? 'dbweb'
const username = process.env.DBWEB_INTEGRATION_USERNAME ?? 'dbweb'
const password = process.env.DBWEB_INTEGRATION_PASSWORD ?? 'dbweb-test-password'
const adminPassword = process.env.DBWEB_INTEGRATION_ADMIN_PASSWORD ?? 'dbweb-root-password'

const postgresSchema = 'dbweb_sql_dump'
const mysqlDatabase = 'dbweb_sql_dump'

describe.runIf(engine === 'postgres')('PostgreSQL SQL dump integration', () => {
  it('round-trips core data and supported advanced objects through a DBWeb package', async () => {
    const version = await postgresScalar('SHOW server_version')
    const major = Number.parseInt(version, 10)
    await setupPostgres(major)
    const connection = resolvedConnection('postgres', database)
    try {
      await roundTrip({
        connection,
        plan: { compression: 'gzip', scope: { kind: 'schema', schema: postgresSchema }, includeData: true },
        snapshot: new PostgresSqlDumpSnapshotSessionFactory(),
        restore: new PostgresSqlRestoreGateway(undefined, undefined, loadPostgresSqlDumpData),
        reset: () => postgresQuery(`DROP SCHEMA ${quotePg(postgresSchema)} CASCADE`),
      })

      expect(await postgresScalar(`SELECT count(*)::text FROM ${quotePg(postgresSchema)}.orders`)).toBe('2')
      expect(await postgresScalar(`SELECT count(*)::text FROM ${quotePg(postgresSchema)}.active_orders`)).toBe('2')
      expect(await postgresScalar(`SELECT ${quotePg(postgresSchema)}.constant_value()::text`)).toBe('7')
      expect(Number(await postgresScalar(
        `SELECT count(*)::text FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '${postgresSchema}' AND t.tgname = 'orders_touch' AND NOT t.tgisinternal`,
      ))).toBe(1)
      if (major >= 10) {
        expect(await postgresScalar(`SELECT count(*)::text FROM ${quotePg(postgresSchema)}.events`)).toBe('1')
      }
      if (major >= 11) {
        expect(Number(await postgresScalar(
          `SELECT count(*)::text FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '${postgresSchema}' AND p.proname = 'refresh_orders' AND p.prokind = 'p'`,
        ))).toBe(1)
      }
    } finally {
      await postgresQuery(`DROP SCHEMA IF EXISTS ${quotePg(postgresSchema)} CASCADE`)
    }
  }, 120_000)
})

describe.runIf(engine === 'mysql')('MySQL SQL dump integration', () => {
  it('round-trips core data and supported advanced objects through a DBWeb package', async () => {
    await setupMysql()
    const connection = resolvedConnection('mysql', mysqlDatabase)
    try {
      await roundTrip({
        connection,
        plan: { compression: 'gzip', scope: { kind: 'database' }, includeData: true },
        snapshot: new MysqlSqlDumpSnapshotSessionFactory(),
        restore: new MysqlSqlRestoreGateway(undefined, undefined, loadMysqlSqlDumpData),
        reset: recreateMysqlDatabase,
      })

      expect(await mysqlScalar('SELECT COUNT(*) AS value FROM `orders`', mysqlDatabase)).toBe('2')
      expect(await mysqlScalar('SELECT COUNT(*) AS value FROM `active_orders`', mysqlDatabase)).toBe('2')
      expect(await mysqlScalar('SELECT `constant_value`() AS value', mysqlDatabase)).toBe('7')
      expect(await mysqlScalar(
        `SELECT COUNT(*) AS value FROM information_schema.triggers
         WHERE trigger_schema = '${mysqlDatabase}' AND trigger_name = 'orders_touch'`,
      )).toBe('1')
      expect(await mysqlScalar('SELECT COUNT(*) AS value FROM `events`', mysqlDatabase)).toBe('1')
      expect(await mysqlScalar(
        `SELECT COUNT(*) AS value FROM information_schema.events
         WHERE event_schema = '${mysqlDatabase}' AND event_name = 'purge_orders'`,
      )).toBe('1')
    } finally {
      await mysqlAdminQuery(`DROP DATABASE IF EXISTS ${quoteMysql(mysqlDatabase)}`)
    }
  }, 120_000)
})

interface RoundTripInput {
  connection: ResolvedConnection
  plan: SqlDumpExportPlan
  snapshot: SqlDumpSnapshotSessionFactory
  restore: SqlRestoreExecutionGateway
  reset(): Promise<void>
}

async function roundTrip(input: RoundTripInput): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dbweb-sql-dump-'))
  const jobId = randomUUID()
  const encryption = new EnvelopeEncryption(Buffer.alloc(32, 41))
  const stage = new EncryptedChunkStore({ root: join(directory, 'stage'), encryption, purposeNamespace: 'sql-stage' })
  const output = new EncryptedChunkStore({ root: join(directory, 'output'), encryption, purposeNamespace: 'output' })
  const packageWriter = new SqlDumpPackageWriter(
    new TransferOutputWriter(stage), stage, new TransferOutputWriter(output),
  )
  try {
    let packaged: Awaited<ReturnType<SqlDumpPackageWriter['write']>>
    try {
      packaged = await new SqlDumpSnapshotCatalog(input.snapshot).withSnapshot(
        input.connection,
        input.plan,
        new AbortController().signal,
        (catalog) => packageWriter.write(jobId, catalog.manifest, catalog.entries, { compression: 'gzip' }),
      )
    } catch (error) {
      await diagnoseSnapshot(input, error)
      throw error
    }
    await input.reset()
    const restorePlan = buildSqlRestorePlan(packaged.manifest, {
      engine: input.connection.engine,
      targetDatabase: input.connection.database,
      existingObjectIds: [],
      mode: 'stop',
      supportedKinds: supportedKinds(packaged.manifest),
    })
    const session = await input.restore.open(input.connection, input.connection.database)
    try {
      await session.begin()
      await executeSteps(session, restorePlan.steps.filter((step) => step.phase === 'structure'))
      const data = new Map(restorePlan.steps
        .filter((step) => step.phase === 'data' && step.dataEntry)
        .map((step) => [step.dataEntry!, step.objectId]))
      await readSqlDumpPackage(storedChunks(output, jobId), async (manifest, entry, content) => {
        if (entry.kind !== 'data') return
        const objectId = data.get(entry.path)
        const object = manifest.objects.find((candidate) => candidate.id === objectId)
        if (!object || object.id !== entry.objectId) throw new Error('Changed integration package')
        await session.restoreData(object, entry.path, content, new AbortController().signal)
        data.delete(entry.path)
      }, { compression: 'gzip' })
      if (data.size > 0) throw new Error('Missing integration data entry')
      await executeSteps(session, restorePlan.steps.filter((step) => step.phase === 'dependent'))
      await session.commit()
    } catch (error) {
      if (session.transactional) await session.rollback()
      throw error
    } finally {
      await session.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function executeSteps(session: SqlRestoreSession, steps: SqlRestoreStep[]): Promise<void> {
  const signal = new AbortController().signal
  for (const step of steps) {
    for (const command of step.commands) {
      let statements: string[]
      try {
        statements = buildDdlStatements(session.capabilities, command)
      } catch (error) {
        throw new Error(JSON.stringify({
          stage: 'build-ddl',
          objectId: step.objectId,
          command: summarizeCommand(command),
          error: safeError(error),
        }), { cause: error })
      }
      for (const sql of statements) {
        await session.executeStatement(sql, signal)
      }
    }
  }
}

async function diagnoseSnapshot(input: RoundTripInput, originalError: unknown): Promise<never> {
  const session = await input.snapshot.open(input.connection)
  let stage = 'begin'
  try {
    await session.begin(new AbortController().signal)
    stage = 'inspect'
    const catalog = await session.inspect(input.plan, new AbortController().signal)
    stage = 'consume-entry'
    for (const entry of catalog.entries) {
      for await (const chunk of entry.content) void chunk
    }
    stage = 'commit'
    await session.commit()
  } catch (error) {
    try { await session.rollback() } catch { /* Keep the diagnostic error. */ }
    throw new Error(JSON.stringify({ stage, error: safeError(error) }), { cause: error })
  } finally {
    try { await session.close() } catch { /* Keep the diagnostic error. */ }
  }
  throw new Error(JSON.stringify({ stage: 'unknown', error: safeError(originalError) }), { cause: originalError })
}

function summarizeCommand(command: SqlRestoreStep['commands'][number]): Record<string, unknown> {
  if (command.kind !== 'create-table') return { kind: command.kind }
  return {
    kind: command.kind,
    columns: command.columns.map((column) => ({ name: column.name, type: column.type.name })),
  }
}

function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'UnknownError' }
  const driver = error as Error & { code?: unknown; errno?: unknown; sqlState?: unknown }
  return {
    name: error.name,
    message: error.message,
    code: driver.code,
    errno: driver.errno,
    sqlState: driver.sqlState,
  }
}

function supportedKinds(manifest: SqlDumpManifest): SqlDumpObjectKind[] {
  return [...new Set(manifest.objects.map((object) => object.kind))]
}

async function* storedChunks(store: EncryptedChunkStore, jobId: string): AsyncIterable<Buffer> {
  const chunks = await store.list(jobId)
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.index !== index) throw new Error('Non-contiguous SQL dump output')
    yield await store.read(jobId, index)
  }
}

function resolvedConnection(databaseEngine: 'postgres' | 'mysql', targetDatabase: string): ResolvedConnection {
  return {
    id: 'sql-dump-integration', name: 'SQL dump integration', engine: databaseEngine,
    host, port, database: targetDatabase, username, password, tls: { mode: 'disable' },
    keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
  }
}

async function setupPostgres(major: number): Promise<void> {
  await postgresQuery(`
    DROP SCHEMA IF EXISTS ${quotePg(postgresSchema)} CASCADE;
    CREATE SCHEMA ${quotePg(postgresSchema)};
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ${quotePg(postgresSchema)};
    CREATE TYPE ${quotePg(postgresSchema)}.order_state AS ENUM ('new', 'done');
    CREATE DOMAIN ${quotePg(postgresSchema)}.positive_amount AS numeric(12,2) CHECK (VALUE >= 0);
    CREATE SEQUENCE ${quotePg(postgresSchema)}.orders_id_seq;
    CREATE TABLE ${quotePg(postgresSchema)}.orders (
      id bigint PRIMARY KEY DEFAULT nextval('${postgresSchema}.orders_id_seq'::regclass),
      note text
    );
    INSERT INTO ${quotePg(postgresSchema)}.orders (note) VALUES (''), (NULL);
    CREATE VIEW ${quotePg(postgresSchema)}.active_orders AS SELECT id, note FROM ${quotePg(postgresSchema)}.orders;
    CREATE MATERIALIZED VIEW ${quotePg(postgresSchema)}.order_totals AS SELECT count(*) AS total FROM ${quotePg(postgresSchema)}.orders;
    CREATE FUNCTION ${quotePg(postgresSchema)}.constant_value() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 7::bigint $$;
    CREATE FUNCTION ${quotePg(postgresSchema)}.touch_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := COALESCE(NEW.note, ''); RETURN NEW; END $$;
    CREATE TRIGGER orders_touch BEFORE INSERT ON ${quotePg(postgresSchema)}.orders FOR EACH ROW EXECUTE PROCEDURE ${quotePg(postgresSchema)}.touch_order();
  `)
  if (major >= 11) {
    await postgresQuery(`CREATE PROCEDURE ${quotePg(postgresSchema)}.refresh_orders() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$`)
  }
  if (major >= 10) {
    await postgresQuery(`
      CREATE TABLE ${quotePg(postgresSchema)}.events (id bigint NOT NULL) PARTITION BY RANGE (id);
      CREATE TABLE ${quotePg(postgresSchema)}.events_low PARTITION OF ${quotePg(postgresSchema)}.events FOR VALUES FROM (0) TO (100);
      INSERT INTO ${quotePg(postgresSchema)}.events VALUES (1)
    `)
  }
}

async function setupMysql(): Promise<void> {
  await recreateMysqlDatabase()
  await mysqlQuery(`
    CREATE TABLE \`orders\` (
      \`id\` bigint NOT NULL AUTO_INCREMENT,
      \`note\` varchar(100) NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB;
    INSERT INTO \`orders\` (\`note\`) VALUES (''), (NULL);
    CREATE VIEW \`active_orders\` AS SELECT \`id\`, \`note\` FROM \`orders\`;
    CREATE FUNCTION \`constant_value\`() RETURNS int DETERMINISTIC NO SQL RETURN 7;
    CREATE PROCEDURE \`refresh_orders\`() NO SQL SELECT 1;
    CREATE TRIGGER \`orders_touch\` BEFORE INSERT ON \`orders\` FOR EACH ROW SET NEW.note = COALESCE(NEW.note, '');
    CREATE EVENT \`purge_orders\` ON SCHEDULE EVERY 1 DAY ON COMPLETION PRESERVE DISABLE DO DELETE FROM \`orders\` WHERE \`id\` < 0;
    CREATE TABLE \`events\` (\`id\` int NOT NULL) ENGINE=InnoDB
      PARTITION BY RANGE (\`id\`) (
        PARTITION \`events_low\` VALUES LESS THAN (100),
        PARTITION \`events_max\` VALUES LESS THAN MAXVALUE
      );
    INSERT INTO \`events\` VALUES (1)
  `, mysqlDatabase)
}

async function recreateMysqlDatabase(): Promise<void> {
  await mysqlAdminQuery(`
    DROP DATABASE IF EXISTS ${quoteMysql(mysqlDatabase)};
    CREATE DATABASE ${quoteMysql(mysqlDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    GRANT ALL PRIVILEGES ON ${quoteMysql(mysqlDatabase)}.* TO 'dbweb'@'%'
  `)
}

async function postgresQuery(sql: string): Promise<void> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try { await client.query(sql) } finally { await client.end() }
}

async function postgresScalar(sql: string): Promise<string> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try {
    const result = await client.query(sql)
    const value = Object.values(result.rows[0] ?? {})[0]
    return String(value)
  } finally { await client.end() }
}

async function mysqlQuery(sql: string, targetDatabase = database): Promise<void> {
  const client = await mysql.createConnection({
    host, port, database: targetDatabase, user: username, password, multipleStatements: true,
  })
  try { await client.query(sql) } finally { await client.end() }
}

async function mysqlAdminQuery(sql: string): Promise<void> {
  const client = await mysql.createConnection({ host, port, user: 'root', password: adminPassword, multipleStatements: true })
  try { await client.query(sql) } finally { await client.end() }
}

async function mysqlScalar(sql: string, targetDatabase = database): Promise<string> {
  const client = await mysql.createConnection({ host, port, database: targetDatabase, user: username, password })
  try {
    const [rows] = await client.query(sql)
    const value = Array.isArray(rows) ? Object.values((rows[0] ?? {}) as Record<string, unknown>)[0] : undefined
    return String(value)
  } finally { await client.end() }
}

function quotePg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteMysql(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}
