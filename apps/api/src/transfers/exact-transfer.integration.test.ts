import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import { MysqlDataMutationGateway } from '../data/mysql-data-mutation-gateway.js'
import { PostgresDataMutationGateway } from '../data/postgres-data-mutation-gateway.js'
import type { DatabaseValueType } from '../data/tagged-value.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { readExactCsvPackage, ExactCsvPackageWriter } from './exact-csv-package.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import type {
  ExactJsonImportGateway,
  ExactJsonImportRow,
  ExactJsonImportTablePlan,
} from './exact-json-import-service.js'
import type { ExactJsonManifest, ExactJsonRecord, ExactJsonTable } from './exact-json-format.js'
import { readExactJsonPackage } from './exact-json-package-reader.js'
import { ExactJsonPackageWriter } from './exact-json-package-writer.js'
import { MysqlExactJsonImportGateway } from './mysql-exact-json-import-gateway.js'
import { MysqlTransferDataGateway } from './mysql-transfer-data-gateway.js'
import { PostgresExactJsonImportGateway } from './postgres-exact-json-import-gateway.js'
import { PostgresTransferDataGateway } from './postgres-transfer-data-gateway.js'
import {
  applyTransferMapping,
  buildTransferColumnMapping,
  type TransferColumnMappingPlan,
} from './transfer-column-mapping.js'
import type { TransferDataGateway, TransferDataRow } from './transfer-data-gateway.js'
import { buildTransferImportPlan } from './transfer-import-plan.js'
import { TransferOutputWriter } from './transfer-output-writer.js'

const engine = process.env.DBWEB_INTEGRATION_ENGINE
const host = process.env.DBWEB_INTEGRATION_HOST ?? '127.0.0.1'
const port = Number(process.env.DBWEB_INTEGRATION_PORT ?? (engine === 'mysql' ? 3306 : 5432))
const database = process.env.DBWEB_INTEGRATION_DATABASE ?? 'dbweb'
const username = process.env.DBWEB_INTEGRATION_USERNAME ?? 'dbweb'
const password = process.env.DBWEB_INTEGRATION_PASSWORD ?? 'dbweb-test-password'

const connection: ResolvedConnection = {
  id: 'exact-transfer-integration',
  name: 'Exact transfer integration database',
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

describe.runIf(engine === 'postgres')('PostgreSQL exact transfer integration', () => {
  verifyExactRoundTrips({
    schema: 'public',
    metadata: new PostgresDataMutationGateway(),
    exportData: new PostgresTransferDataGateway(),
    importData: new PostgresExactJsonImportGateway(),
    setup: async () => postgresQuery(`
      DROP TABLE IF EXISTS public.dbweb_transfer_target;
      DROP TABLE IF EXISTS public.dbweb_transfer_source;
      CREATE TABLE public.dbweb_transfer_source (
        code varchar(30) PRIMARY KEY,
        amount numeric(12,2) NOT NULL,
        note varchar(100)
      );
      CREATE TABLE public.dbweb_transfer_target (
        code varchar(30) PRIMARY KEY,
        amount numeric(12,2) NOT NULL,
        note varchar(100)
      );
      INSERT INTO public.dbweb_transfer_source (code, amount, note)
      VALUES ('alpha', 10.50, ''), ('beta', 20.75, NULL)
    `),
    clearTarget: async () => postgresQuery('TRUNCATE TABLE public.dbweb_transfer_target'),
    readTarget: async () => postgresRows(
      'SELECT code, amount, note FROM public.dbweb_transfer_target ORDER BY code',
    ),
    cleanup: async () => postgresQuery(`
      DROP TABLE IF EXISTS public.dbweb_transfer_target;
      DROP TABLE IF EXISTS public.dbweb_transfer_source
    `),
  })
})

describe.runIf(engine === 'mysql')('MySQL exact transfer integration', () => {
  verifyExactRoundTrips({
    schema: database,
    metadata: new MysqlDataMutationGateway(),
    exportData: new MysqlTransferDataGateway(),
    importData: new MysqlExactJsonImportGateway(),
    setup: async () => mysqlQuery(`
      DROP TABLE IF EXISTS \`dbweb_transfer_target\`;
      DROP TABLE IF EXISTS \`dbweb_transfer_source\`;
      CREATE TABLE \`dbweb_transfer_source\` (
        \`code\` varchar(30) PRIMARY KEY,
        \`amount\` decimal(12,2) NOT NULL,
        \`note\` varchar(100) NULL
      ) ENGINE=InnoDB;
      CREATE TABLE \`dbweb_transfer_target\` (
        \`code\` varchar(30) PRIMARY KEY,
        \`amount\` decimal(12,2) NOT NULL,
        \`note\` varchar(100) NULL
      ) ENGINE=InnoDB;
      INSERT INTO \`dbweb_transfer_source\` (\`code\`, \`amount\`, \`note\`)
      VALUES ('alpha', 10.50, ''), ('beta', 20.75, NULL)
    `),
    clearTarget: async () => mysqlQuery('TRUNCATE TABLE `dbweb_transfer_target`'),
    readTarget: async () => mysqlRows(
      'SELECT code, amount, note FROM `dbweb_transfer_target` ORDER BY code',
    ),
    cleanup: async () => mysqlQuery(`
      DROP TABLE IF EXISTS \`dbweb_transfer_target\`;
      DROP TABLE IF EXISTS \`dbweb_transfer_source\`
    `),
  })
})

interface RoundTripFixture {
  schema: string
  metadata: DataMutationGateway
  exportData: TransferDataGateway
  importData: ExactJsonImportGateway
  setup(): Promise<void>
  clearTarget(): Promise<void>
  readTarget(): Promise<Array<Record<string, unknown>>>
  cleanup(): Promise<void>
}

function verifyExactRoundTrips(fixture: RoundTripFixture): void {
  it('round-trips exact CSV and exact JSON through encrypted streamed packages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-exact-transfer-'))
    await fixture.setup()
    try {
      const source = await fixture.metadata.describeTable(connection, fixture.schema, 'dbweb_transfer_source')
      const target = await fixture.metadata.describeTable(connection, fixture.schema, 'dbweb_transfer_target')
      const sourceColumns = exactColumns(source.columns)
      const mapping = buildTransferColumnMapping(
        sourceColumns,
        target.columns.map((column) => ({
          name: column.name,
          type: exactType(column.valueType),
          nullable: column.nullable,
          generated: column.generated,
          hasDefault: column.hasDefault === true,
        })),
        [],
      )
      const tablePlan = importTablePlan(sourceColumns, target, mapping)
      const stores = transferStores(directory)

      await roundTripCsv(fixture, source, tablePlan, stores)
      expect(normalizeRows(await fixture.readTarget())).toEqual(expectedRows())

      await fixture.clearTarget()
      await roundTripJson(fixture, source, tablePlan, stores)
      expect(normalizeRows(await fixture.readTarget())).toEqual(expectedRows())
    } finally {
      await fixture.cleanup()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
}

async function roundTripCsv(
  fixture: RoundTripFixture,
  source: Awaited<ReturnType<DataMutationGateway['describeTable']>>,
  tablePlan: ExactJsonImportTablePlan,
  stores: ReturnType<typeof transferStores>,
): Promise<void> {
  const jobId = randomUUID()
  const sidecar: ExactCsvSidecar = {
    format: 'dbweb-exact-csv',
    version: 1,
    schema: source.schema,
    table: source.name,
    delimiter: ',',
    bom: true,
    columns: exactColumns(source.columns),
  }
  const writer = new ExactCsvPackageWriter(
    new TransferOutputWriter(stores.csvStage),
    stores.csvStage,
    new TransferOutputWriter(stores.output),
  )
  await writer.write(jobId, sidecar, fixture.exportData.stream(connection, {
    table: source, filters: [], batchSize: 100,
  }), { compression: 'gzip' })

  await readExactCsvPackage(storedChunks(stores.output, jobId), async (actual, rows) => {
    expect(actual).toEqual(sidecar)
    const result = await fixture.importData.execute(connection, {
      transaction: 'atomic', batchSize: 100, tables: [tablePlan],
      rows: csvImportRows(rows, tablePlan.mapping), signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ processedRows: 2, insertedRows: 2 })
  }, { compression: 'gzip' })
}

async function roundTripJson(
  fixture: RoundTripFixture,
  source: Awaited<ReturnType<DataMutationGateway['describeTable']>>,
  tablePlan: ExactJsonImportTablePlan,
  stores: ReturnType<typeof transferStores>,
): Promise<void> {
  const jobId = randomUUID()
  const sourceTable: ExactJsonTable = {
    id: 'source', schema: source.schema, table: source.name, columns: exactColumns(source.columns),
  }
  const manifest: ExactJsonManifest = {
    kind: 'manifest', format: 'dbweb-exact-json', version: 1, tables: [sourceTable],
  }
  const writer = new ExactJsonPackageWriter(
    new TransferOutputWriter(stores.jsonStage),
    stores.jsonStage,
    new TransferOutputWriter(stores.output),
  )
  await writer.write(jobId, manifest, jsonRecords(fixture.exportData.stream(connection, {
    table: source, filters: [], batchSize: 100,
  })), { compression: 'gzip' })

  await readExactJsonPackage(storedChunks(stores.output, jobId), async (actual, records) => {
    expect(actual).toEqual(manifest)
    const result = await fixture.importData.execute(connection, {
      transaction: 'atomic', batchSize: 100, tables: [{ ...tablePlan, source: sourceTable }],
      rows: jsonImportRows(records, tablePlan.mapping), signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ processedRows: 2, insertedRows: 2 })
  }, { compression: 'gzip' })
}

function transferStores(directory: string) {
  const encryption = new EnvelopeEncryption(Buffer.alloc(32, 29))
  return {
    csvStage: new EncryptedChunkStore({ root: join(directory, 'csv-stage'), encryption, purposeNamespace: 'csv-stage' }),
    jsonStage: new EncryptedChunkStore({ root: join(directory, 'json-stage'), encryption, purposeNamespace: 'json-stage' }),
    output: new EncryptedChunkStore({ root: join(directory, 'output'), encryption, purposeNamespace: 'output' }),
  }
}

function importTablePlan(
  sourceColumns: Array<{ name: string; type: DatabaseValueType }>,
  target: Awaited<ReturnType<DataMutationGateway['describeTable']>>,
  mapping: TransferColumnMappingPlan,
): ExactJsonImportTablePlan {
  return {
    sourceId: 'source',
    source: { id: 'source', schema: 'source', table: 'source', columns: sourceColumns },
    target,
    mapping,
    conflict: buildTransferImportPlan(target, {
      conflict: 'skip', transaction: 'atomic', batchSize: 100,
    }),
  }
}

function exactColumns(
  columns: Awaited<ReturnType<DataMutationGateway['describeTable']>>['columns'],
): Array<{ name: string; type: DatabaseValueType }> {
  return columns.map((column) => ({ name: column.name, type: exactType(column.valueType) }))
}

function exactType(type: DatabaseValueType | 'unsupported'): DatabaseValueType {
  if (type === 'unsupported') throw new Error('Unexpected unsupported integration column')
  return type
}

async function* storedChunks(store: EncryptedChunkStore, jobId: string): AsyncIterable<Buffer> {
  const chunks = await store.list(jobId)
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.index !== index) throw new Error('Non-contiguous integration output')
    yield await store.read(jobId, index)
  }
}

async function* csvImportRows(
  rows: AsyncIterable<Record<string, import('../data/tagged-value.js').TaggedDatabaseValue>>,
  mapping: TransferColumnMappingPlan,
): AsyncIterable<ExactJsonImportRow> {
  for await (const row of rows) yield { sourceId: 'source', values: applyTransferMapping(row, mapping) }
}

async function* jsonRecords(rows: AsyncIterable<TransferDataRow>): AsyncIterable<ExactJsonRecord> {
  for await (const values of rows) yield { kind: 'row', table: 'source', values }
}

async function* jsonImportRows(
  records: AsyncIterable<ExactJsonRecord>,
  mapping: TransferColumnMappingPlan,
): AsyncIterable<ExactJsonImportRow> {
  for await (const record of records) yield {
    sourceId: record.table,
    values: applyTransferMapping(record.values, mapping),
  }
}

function normalizeRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    code: String(row.code), amount: String(row.amount), note: row.note === null ? null : String(row.note),
  }))
}

function expectedRows() {
  return [
    { code: 'alpha', amount: '10.50', note: '' },
    { code: 'beta', amount: '20.75', note: null },
  ]
}

async function postgresQuery(sql: string): Promise<void> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try { await client.query(sql) } finally { await client.end() }
}

async function postgresRows(sql: string): Promise<Array<Record<string, unknown>>> {
  const client = new Client({ host, port, database, user: username, password })
  await client.connect()
  try { return (await client.query(sql)).rows as Array<Record<string, unknown>> }
  finally { await client.end() }
}

async function mysqlQuery(sql: string): Promise<void> {
  const client = await mysql.createConnection({
    host, port, database, user: username, password, multipleStatements: true,
  })
  try { await client.query(sql) } finally { await client.end() }
}

async function mysqlRows(sql: string): Promise<Array<Record<string, unknown>>> {
  const client = await mysql.createConnection({ host, port, database, user: username, password })
  try {
    const [rows] = await client.query(sql)
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
  } finally { await client.end() }
}
