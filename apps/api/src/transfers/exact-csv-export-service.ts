import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type { TransferDataGateway, TransferDataRow } from './transfer-data-gateway.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import type { ExactCsvPackageWriter } from './exact-csv-package.js'
import type { TransferFilter } from './transfer-filter.js'
import {
  TransferJobError,
  type StoredTransferJob,
  type TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import type { TransferOutputResult } from './transfer-output-writer.js'

export interface ExactCsvExportPlan {
  table: MutationTable
  filters: TransferFilter[]
  delimiter: ',' | '\t' | ';'
  bom: boolean
  compression: 'none' | 'gzip'
}

export interface ExactCsvExportPreviewValidator {
  validate(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string, token: string): Promise<ExactCsvExportPlan>
}

export type ExactCsvExportAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export type ExactCsvExportErrorCode = 'EXPORT_CANCELLED' | 'EXPORT_FAILED' | 'FORBIDDEN' | 'INVALID_EXPORT_JOB'

export class ExactCsvExportError extends Error {
  constructor(readonly code: ExactCsvExportErrorCode) {
    super(code)
    this.name = 'ExactCsvExportError'
  }
}

export class ExactCsvExportService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; finish(): void }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, TransferDataGateway>,
    private readonly packages: Pick<ExactCsvPackageWriter, 'delete' | 'write'>,
    private readonly preview: ExactCsvExportPreviewValidator,
    private readonly authorize: ExactCsvExportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
    externalSignal = new AbortController().signal,
  ): Promise<TransferOutputResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new ExactCsvExportError('FORBIDDEN')
    if (job.direction !== 'export' || job.format !== 'csv' || job.status !== 'previewed') invalidJob()
    const plan = validatePlan(await this.preview.validate(actor, jobId, token))
    const connection = await this.connections.resolveConnection(job.connectionId)
    if (this.active.has(jobId)) invalidJob()
    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.active.set(jobId, { controller, done, finish })
    let rows = 0
    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'running', { updatedAt: this.now().toISOString() }))
      const stream = this.count(this.gateways[connection.engine].stream(connection, {
        table: plan.table, filters: plan.filters, batchSize: 1_000, signal,
      }), () => { rows += 1 })
      const result = await this.packages.write(jobId, sidecarFor(plan), stream, { compression: plan.compression, signal })
      if (signal.aborted) throw new ExactCsvExportError('EXPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id, jobId, connectionId: job.connectionId,
        direction: 'export', format: 'csv', action: 'export', status: 'success',
        details: { bytes: result.bytes, checksum: result.checksum },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(), processedBytes: current.processedBytes + result.bytes,
        processedRows: current.processedRows + rows, processedTables: current.processedTables + 1,
      }))
      return result
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof ExactCsvExportError && error.code === 'EXPORT_CANCELLED')
      await this.packages.delete(jobId).catch(() => undefined)
      await markStopped(this.jobs, actor, jobId, cancelled ? 'cancelled' : 'failed', this.now)
      throw new ExactCsvExportError(cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED')
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

  private async *count(rows: AsyncIterable<TransferDataRow>, increment: () => void): AsyncIterable<TransferDataRow> {
    for await (const row of rows) {
      increment()
      yield row
    }
  }
}

function validatePlan(plan: ExactCsvExportPlan): ExactCsvExportPlan {
  if (plan.table.columns.length === 0 || plan.table.columns.some((column) => column.valueType === 'unsupported')) invalidJob()
  return plan
}

function sidecarFor(plan: ExactCsvExportPlan): ExactCsvSidecar {
  return {
    format: 'dbweb-exact-csv', version: 1,
    schema: plan.table.schema, table: plan.table.name,
    delimiter: plan.delimiter, bom: plan.bom,
    columns: plan.table.columns.map((column) => ({
      name: column.name,
      type: column.valueType === 'unsupported' ? invalidJob() : column.valueType,
    })),
  }
}

async function markStopped(
  jobs: TransferJobService,
  actor: Pick<AuthUser, 'id' | 'role'>,
  jobId: string,
  status: 'cancelled' | 'failed',
  now: () => Date,
): Promise<void> {
  try {
    await jobs.update(actor, jobId, (current) => transitionTransferJob(current, status, {
      updatedAt: now().toISOString(), ...(status === 'failed' ? { errorCount: current.errorCount + 1 } : {}),
    }))
  } catch (error) {
    if (!(error instanceof TransferJobError)) throw error
  }
}

function invalidJob(): never { throw new ExactCsvExportError('INVALID_EXPORT_JOB') }
