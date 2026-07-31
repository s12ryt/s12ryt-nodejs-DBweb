import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  ExactJsonImportGatewayError,
  type ExactJsonImportGateway,
  type ExactJsonImportResult,
  type ExactJsonImportRow,
  type ExactJsonImportTablePlan,
} from './exact-json-import-service.js'
import { buildMysqlImportStatements } from './exact-json-import-sql.js'
import { emptyProgress, mergeProgress } from './postgres-exact-json-import-gateway.js'

export { ExactJsonImportGatewayError } from './exact-json-import-service.js'

export interface MysqlImportConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  end(): Promise<void>
}

type MysqlImportConnectionFactory = (options: MysqlClientOptions) => Promise<MysqlImportConnection>

export class MysqlExactJsonImportGateway implements ExactJsonImportGateway {
  constructor(
    private readonly createConnection: MysqlImportConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlImportConnection,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async execute(
    connection: ResolvedConnection,
    request: Parameters<ExactJsonImportGateway['execute']>[1],
  ): Promise<ExactJsonImportResult> {
    let socket: Duplex | undefined
    let client: MysqlImportConnection | undefined
    const progress = emptyProgress()
    try {
      validateRequest(request)
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions(connection, socket))
      if (request.transaction === 'atomic') {
        await client.beginTransaction()
        const pending = emptyProgress()
        try {
          for await (const row of request.rows) await importMysqlRow(client, row, request.tables, pending, request.signal)
          await client.commit()
          mergeProgress(progress, pending)
          progress.batches = 1
        } catch (error) {
          await rollbackMysql(client)
          if (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED') {
            throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', structuredClone(progress))
          }
          throw error
        }
      } else {
        await importMysqlBatches(client, request, progress)
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

async function importMysqlBatches(
  client: MysqlImportConnection,
  request: Parameters<ExactJsonImportGateway['execute']>[1],
  progress: ExactJsonImportResult,
): Promise<void> {
  let batch: ExactJsonImportRow[] = []
  for await (const row of request.rows) {
    batch.push(row)
    if (batch.length === request.batchSize) {
      await executeMysqlBatch(client, batch, request.tables, request.signal, progress)
      batch = []
    }
  }
  if (batch.length > 0) await executeMysqlBatch(client, batch, request.tables, request.signal, progress)
}

async function executeMysqlBatch(
  client: MysqlImportConnection,
  rows: ExactJsonImportRow[],
  tables: ExactJsonImportTablePlan[],
  signal: AbortSignal,
  progress: ExactJsonImportResult,
): Promise<void> {
  await client.beginTransaction()
  const pending = emptyProgress()
  try {
    for (const row of rows) await importMysqlRow(client, row, tables, pending, signal)
    await client.commit()
    mergeProgress(progress, pending)
    progress.batches += 1
  } catch (error) {
    await rollbackMysql(client)
    if (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED') {
      throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', structuredClone(progress))
    }
    throw error
  }
}

async function importMysqlRow(
  client: MysqlImportConnection,
  row: ExactJsonImportRow,
  tables: ExactJsonImportTablePlan[],
  progress: ExactJsonImportResult,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', progress)
  const plan = tables.find((item) => item.sourceId === row.sourceId)
  if (!plan) throw new Error('INVALID_IMPORT_DATA')
  const statements = buildMysqlImportStatements(plan, row.values)
  let affectedRows = 0
  for (const statement of statements) {
    const [raw] = await client.query(statement.sql, statement.values)
    affectedRows = resultAffectedRows(raw)
  }
  progress.processedRows += 1
  if (plan.conflict.conflict === 'skip' && affectedRows === 0) progress.skippedRows += 1
  else if (plan.conflict.conflict === 'update' && affectedRows > 1) progress.updatedRows += 1
  else progress.insertedRows += 1
}

function resultAffectedRows(value: unknown): number {
  if (!value || typeof value !== 'object') throw new Error('INVALID_IMPORT_RESULT')
  const count = (value as { affectedRows?: unknown }).affectedRows
  if (typeof count !== 'number' || count < 0) throw new Error('INVALID_IMPORT_RESULT')
  return count
}

async function rollbackMysql(client: MysqlImportConnection): Promise<void> {
  try { await client.rollback() } catch { /* Preserve original error. */ }
}

function validateRequest(request: Parameters<ExactJsonImportGateway['execute']>[1]): void {
  if (request.tables.length === 0 || !Number.isSafeInteger(request.batchSize) || request.batchSize < 100 || request.batchSize > 10_000) {
    throw new Error('INVALID_IMPORT_DATA')
  }
}
