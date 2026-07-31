import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import { applyTransferMapping, type TransferColumnMappingPlan } from './transfer-column-mapping.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import type { ExactJsonTable } from './exact-json-format.js'
import type {
  ExactJsonImportGateway,
  ExactJsonImportResult,
  ExactJsonImportTablePlan,
  TransferSourcePackageStore,
} from './exact-json-import-service.js'
import { ExactJsonImportGatewayError } from './exact-json-import-service.js'
import type { TransferImportPlan } from './transfer-import-plan.js'
import {
  TransferJobError,
  type StoredTransferJob,
  type TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'

export interface ExactCsvImportPlan {
  compression: 'none' | 'gzip'
  transaction: 'atomic' | 'batch'
  batchSize: number
  source: ExactCsvSidecar
  target: MutationTable
  mapping: TransferColumnMappingPlan
  conflict: TransferImportPlan
}

export interface ExactCsvImportPreviewValidator {
  validate(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string, token: string): Promise<ExactCsvImportPlan>
}

export interface ExactCsvPackageReader {
  read<T>(
    chunks: AsyncIterable<Uint8Array>,
    handler: (sidecar: ExactCsvSidecar, rows: AsyncIterable<Record<string, TaggedDatabaseValue>>) => Promise<T>,
    options: { compression: 'none' | 'gzip' },
  ): Promise<T>
}

export type ExactCsvImportAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export class ExactCsvImportError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'IMPORT_CANCELLED' | 'IMPORT_FAILED' | 'INVALID_IMPORT_JOB') {
    super(code)
    this.name = 'ExactCsvImportError'
  }
}

export class ExactCsvImportService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; finish(): void }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, ExactJsonImportGateway>,
    private readonly source: TransferSourcePackageStore,
    private readonly packages: ExactCsvPackageReader,
    private readonly preview: ExactCsvImportPreviewValidator,
    private readonly authorize: ExactCsvImportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
    externalSignal = new AbortController().signal,
  ): Promise<ExactJsonImportResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new ExactCsvImportError('FORBIDDEN')
    if (job.direction !== 'import' || job.format !== 'csv' || job.status !== 'previewed' || !job.uploadCompletedAt || !job.sourceChecksum) invalidJob()
    const plan = await this.preview.validate(actor, jobId, token)
    const connection = await this.connections.resolveConnection(job.connectionId)
    if (this.active.has(jobId)) invalidJob()
    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.active.set(jobId, { controller, done, finish })
    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'running', { updatedAt: this.now().toISOString() }))
      const tablePlan = toTablePlan(plan)
      const result = await this.packages.read(
        this.source.stream(jobId),
        async (sidecar, rows) => {
          if (!sameSidecar(sidecar, plan.source)) throw new ExactCsvImportError('IMPORT_FAILED')
          return this.gateways[connection.engine].execute(connection, {
            transaction: plan.transaction, batchSize: plan.batchSize, tables: [tablePlan],
            rows: mapRows(rows, plan.mapping), signal,
          })
        },
        { compression: plan.compression },
      )
      if (signal.aborted) throw new ExactCsvImportError('IMPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id, jobId, connectionId: job.connectionId,
        direction: 'import', format: 'csv', action: 'import', status: 'success',
        details: { bytes: job.sourceBytes ?? 0 },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(), processedRows: current.processedRows + result.processedRows,
        processedTables: current.processedTables + 1,
      }))
      return result
    } catch (error) {
      const partial = error instanceof ExactJsonImportGatewayError ? error.progress : emptyProgress()
      const cancelled = signal.aborted || (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED')
      await markStopped(this.jobs, actor, jobId, cancelled ? 'cancelled' : 'failed', partial.processedRows, this.now)
      throw new ExactCsvImportError(cancelled ? 'IMPORT_CANCELLED' : 'IMPORT_FAILED')
    } finally {
      const active = this.active.get(jobId)
      if (active?.controller === controller) {
        this.active.delete(jobId)
        active.finish()
      }
    }
  }

  async cancel(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string): Promise<StoredTransferJob> {
    await this.jobs.get(actor, jobId)
    const active = this.active.get(jobId)
    if (!active) return this.jobs.cancel(actor, jobId)
    active.controller.abort()
    await active.done
    return this.jobs.get(actor, jobId)
  }
}

function toTablePlan(plan: ExactCsvImportPlan): ExactJsonImportTablePlan {
  const source: ExactJsonTable = {
    id: 'csv', schema: plan.source.schema, table: plan.source.table, columns: structuredClone(plan.source.columns),
  }
  return { sourceId: 'csv', source, target: plan.target, mapping: plan.mapping, conflict: plan.conflict }
}

async function* mapRows(
  rows: AsyncIterable<Record<string, TaggedDatabaseValue>>,
  mapping: TransferColumnMappingPlan,
) {
  for await (const row of rows) yield { sourceId: 'csv', values: applyTransferMapping(row, mapping) }
}

function sameSidecar(actual: ExactCsvSidecar, expected: ExactCsvSidecar): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function markStopped(
  jobs: TransferJobService,
  actor: Pick<AuthUser, 'id' | 'role'>,
  jobId: string,
  status: 'cancelled' | 'failed',
  processedRows: number,
  now: () => Date,
): Promise<void> {
  try {
    await jobs.update(actor, jobId, (current) => transitionTransferJob(current, status, {
      updatedAt: now().toISOString(), processedRows: current.processedRows + processedRows,
      ...(status === 'failed' ? { errorCount: current.errorCount + 1 } : {}),
    }))
  } catch (error) {
    if (!(error instanceof TransferJobError)) throw error
  }
}

function emptyProgress(): ExactJsonImportResult {
  return { processedRows: 0, insertedRows: 0, updatedRows: 0, skippedRows: 0, batches: 0 }
}

function invalidJob(): never { throw new ExactCsvImportError('INVALID_IMPORT_JOB') }
