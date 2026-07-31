import type { Duplex } from 'node:stream'

import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { postgresClientConfig, type PostgresQueryResult } from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  ExactJsonImportGatewayError,
  type ExactJsonImportGateway,
  type ExactJsonImportResult,
  type ExactJsonImportRow,
  type ExactJsonImportTablePlan,
} from './exact-json-import-service.js'
import { buildPostgresImportStatements } from './exact-json-import-sql.js'

export interface PostgresImportClient {
  connect(): Promise<unknown>
  query(sql: string, values?: unknown[]): Promise<PostgresQueryResult>
  end(): Promise<void>
}

type PostgresImportClientFactory = (config: ReturnType<typeof postgresClientConfig>) => PostgresImportClient

export class PostgresExactJsonImportGateway implements ExactJsonImportGateway {
  constructor(
    private readonly createClient: PostgresImportClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async execute(
    connection: ResolvedConnection,
    request: Parameters<ExactJsonImportGateway['execute']>[1],
  ): Promise<ExactJsonImportResult> {
    let socket: Duplex | undefined
    let client: PostgresImportClient | undefined
    const progress = emptyProgress()
    try {
      validateRequest(request)
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      if (request.transaction === 'atomic') {
        await client.query('BEGIN')
        try {
          const pending = emptyProgress()
          for await (const row of request.rows) await importPostgresRow(client, row, request.tables, pending, request.signal)
          await synchronizePostgresIdentities(client, request.tables)
          await client.query('COMMIT')
          mergeProgress(progress, pending)
          progress.batches = 1
        } catch (error) {
          await rollbackPostgres(client)
          if (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED') {
            throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', structuredClone(progress))
          }
          throw error
        }
      } else {
        await importPostgresBatches(client, request, progress)
      }
      return progress
    } catch (error) {
      if (error instanceof ExactJsonImportGatewayError) throw error
      throw new ExactJsonImportGatewayError(request.signal.aborted ? 'IMPORT_DATA_CANCELLED' : 'IMPORT_DATA_FAILED', progress)
    } finally {
      try { await client?.end() } catch { /* Cleanup cannot replace the safe result. */ }
      socket?.destroy()
    }
  }
}

async function importPostgresBatches(
  client: PostgresImportClient,
  request: Parameters<ExactJsonImportGateway['execute']>[1],
  progress: ExactJsonImportResult,
): Promise<void> {
  let batch: ExactJsonImportRow[] = []
  for await (const row of request.rows) {
    batch.push(row)
    if (batch.length === request.batchSize) {
      await executePostgresBatch(client, batch, request.tables, request.signal, progress)
      batch = []
    }
  }
  if (batch.length > 0) await executePostgresBatch(client, batch, request.tables, request.signal, progress)
}

async function executePostgresBatch(
  client: PostgresImportClient,
  rows: ExactJsonImportRow[],
  tables: ExactJsonImportTablePlan[],
  signal: AbortSignal,
  progress: ExactJsonImportResult,
): Promise<void> {
  await client.query('BEGIN')
  const pending = emptyProgress()
  try {
    for (const row of rows) await importPostgresRow(client, row, tables, pending, signal)
    await synchronizePostgresIdentities(client, tables)
    await client.query('COMMIT')
    mergeProgress(progress, pending)
    progress.batches += 1
  } catch (error) {
    await rollbackPostgres(client)
    if (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED') {
      throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', structuredClone(progress))
    }
    throw error
  }
}

async function importPostgresRow(
  client: PostgresImportClient,
  row: ExactJsonImportRow,
  tables: ExactJsonImportTablePlan[],
  progress: ExactJsonImportResult,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', progress)
  const plan = tables.find((item) => item.sourceId === row.sourceId)
  if (!plan) throw new Error('INVALID_IMPORT_DATA')
  const statements = buildPostgresImportStatements(plan, row.values)
  let result: PostgresQueryResult | undefined
  for (const statement of statements) result = await client.query(statement.sql, statement.values)
  progress.processedRows += 1
  if (plan.conflict.conflict === 'skip' && (result?.rowCount ?? 0) === 0) progress.skippedRows += 1
  else if (plan.conflict.conflict === 'update' && result?.rows[0]?.dbweb_inserted === false) progress.updatedRows += 1
  else progress.insertedRows += 1
}

async function synchronizePostgresIdentities(
  client: PostgresImportClient,
  tables: ExactJsonImportTablePlan[],
): Promise<void> {
  const targets = new Map<string, ExactJsonImportTablePlan>()
  for (const plan of tables) {
    if (!plan.conflict.preserveIdentity) continue
    targets.set(`${plan.target.schema}\0${plan.target.name}`, plan)
  }
  for (const plan of targets.values()) {
    const generatedIdentity = plan.conflict.identity?.columns.find((name) =>
      plan.target.columns.some((column) => column.name === name && column.generated))
    if (!generatedIdentity) continue
    const sequence = await client.query(
      'SELECT pg_get_serial_sequence($1, $2) AS dbweb_sequence',
      [`${plan.target.schema}.${plan.target.name}`, generatedIdentity],
    )
    const sequenceName = sequence.rows[0]?.dbweb_sequence
    if (typeof sequenceName !== 'string') continue
    const table = `"${plan.target.schema.replaceAll('"', '""')}"."${plan.target.name.replaceAll('"', '""')}"`
    const column = `"${generatedIdentity.replaceAll('"', '""')}"`
    await client.query(
      `SELECT setval($1::regclass, COALESCE(MAX(${column}), 1), COUNT(*) > 0) FROM ${table}`,
      [sequenceName],
    )
  }
}

async function rollbackPostgres(client: PostgresImportClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* Preserve original error. */ }
}

function validateRequest(request: Parameters<ExactJsonImportGateway['execute']>[1]): void {
  if (request.tables.length === 0 || !Number.isSafeInteger(request.batchSize) || request.batchSize < 100 || request.batchSize > 10_000) {
    throw new Error('INVALID_IMPORT_DATA')
  }
}

export function emptyProgress(): ExactJsonImportResult {
  return { processedRows: 0, insertedRows: 0, updatedRows: 0, skippedRows: 0, batches: 0 }
}

export function mergeProgress(target: ExactJsonImportResult, source: ExactJsonImportResult): void {
  target.processedRows += source.processedRows
  target.insertedRows += source.insertedRows
  target.updatedRows += source.updatedRows
  target.skippedRows += source.skippedRows
}
