import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type {
  TransferDataBatchRequest,
  TransferDataBatchRow,
  TransferDataGateway,
} from './transfer-data-gateway.js'
import type { ExactJsonManifest, ExactJsonRecord } from './exact-json-format.js'
import type { ExactJsonPackageWriter } from './exact-json-package-writer.js'
import type { TransferFilter } from './transfer-filter.js'
import {
  TransferJobError,
  type StoredTransferJob,
  type TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import type { TransferOutputResult } from './transfer-output-writer.js'

export interface ExactJsonExportTablePlan {
  id: string
  table: MutationTable
  filters: TransferFilter[]
  includeData: boolean
}

export interface ExactJsonExportPlan {
  compression: 'none' | 'gzip'
  tables: ExactJsonExportTablePlan[]
}

export interface ExactJsonPreviewValidator {
  validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<ExactJsonExportPlan>
}

export type ExactJsonExportAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

type MultiTableGateway = TransferDataGateway & Required<Pick<TransferDataGateway, 'streamMany'>>

export type ExactJsonExportErrorCode =
  | 'EXPORT_CANCELLED'
  | 'EXPORT_FAILED'
  | 'FORBIDDEN'
  | 'INVALID_EXPORT_JOB'

export class ExactJsonExportError extends Error {
  constructor(readonly code: ExactJsonExportErrorCode) {
    super(code)
    this.name = 'ExactJsonExportError'
  }
}

export class ExactJsonExportService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; finish(): void }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, MultiTableGateway>,
    private readonly packages: Pick<ExactJsonPackageWriter, 'delete' | 'write'>,
    private readonly preview: ExactJsonPreviewValidator,
    private readonly authorize: ExactJsonExportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    previewToken: string,
    externalSignal = new AbortController().signal,
  ): Promise<TransferOutputResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new ExactJsonExportError('FORBIDDEN')
    if (job.direction !== 'export' || job.format !== 'json' || job.status !== 'previewed') {
      throw new ExactJsonExportError('INVALID_EXPORT_JOB')
    }
    const plan = this.validatePlan(await this.preview.validate(actor, jobId, previewToken))
    const connection = await this.connections.resolveConnection(job.connectionId)
    if (this.active.has(jobId)) throw new ExactJsonExportError('INVALID_EXPORT_JOB')
    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.active.set(jobId, { controller, done, finish })
    let processedRows = 0

    try {
      await this.jobs.update(actor, jobId, (current) =>
        transitionTransferJob(current, 'running', { updatedAt: this.now().toISOString() }))
      const requests: TransferDataBatchRequest[] = plan.tables
        .filter((table) => table.includeData)
        .map((table) => ({
          id: table.id,
          request: { table: table.table, filters: table.filters, batchSize: 1_000, signal },
        }))
      const gateway = this.gateways[connection.engine]
      const rows = requests.length === 0
        ? emptyBatchRows()
        : gateway.streamMany(connection, requests)
      const records = this.records(rows, () => { processedRows += 1 })
      const result = await this.packages.write(
        jobId,
        this.manifest(plan),
        records,
        { compression: plan.compression, signal },
      )
      if (signal.aborted) throw new ExactJsonExportError('EXPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: job.connectionId,
        direction: 'export',
        format: 'json',
        action: 'export',
        status: 'success',
        details: { bytes: result.bytes, checksum: result.checksum },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(),
        processedBytes: current.processedBytes + result.bytes,
        processedRows: current.processedRows + processedRows,
        processedTables: current.processedTables + plan.tables.length,
      }))
      return result
    } catch (error) {
      const cancelled = signal.aborted
        || (error instanceof ExactJsonExportError && error.code === 'EXPORT_CANCELLED')
      await this.packages.delete(jobId).catch(() => undefined)
      await this.markStopped(actor, jobId, cancelled ? 'cancelled' : 'failed')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: job.connectionId,
        direction: 'export',
        format: 'json',
        action: 'export',
        status: 'failed',
        errorCode: cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
      }).catch(() => undefined)
      throw new ExactJsonExportError(cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED')
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

  private validatePlan(plan: ExactJsonExportPlan): ExactJsonExportPlan {
    if (plan.tables.length === 0 || new Set(plan.tables.map((table) => table.id)).size !== plan.tables.length) {
      throw new ExactJsonExportError('INVALID_EXPORT_JOB')
    }
    for (const item of plan.tables) {
      if (!item.id || item.table.columns.length === 0 || item.table.columns.some((column) => column.valueType === 'unsupported')) {
        throw new ExactJsonExportError('INVALID_EXPORT_JOB')
      }
    }
    return plan
  }

  private manifest(plan: ExactJsonExportPlan): ExactJsonManifest {
    return {
      kind: 'manifest',
      format: 'dbweb-exact-json',
      version: 1,
      tables: plan.tables.map((item) => ({
        id: item.id,
        schema: item.table.schema,
        table: item.table.name,
        columns: item.table.columns.map((column) => ({ name: column.name, type: column.valueType as Exclude<typeof column.valueType, 'unsupported'> })),
      })),
    }
  }

  private async *records(rows: AsyncIterable<TransferDataBatchRow>, count: () => void): AsyncIterable<ExactJsonRecord> {
    for await (const item of rows) {
      count()
      yield { kind: 'row', table: item.id, values: item.row }
    }
  }

  private async markStopped(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    status: 'cancelled' | 'failed',
  ): Promise<void> {
    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, status, {
        updatedAt: this.now().toISOString(),
        ...(status === 'failed' ? { errorCount: current.errorCount + 1 } : {}),
      }))
    } catch (error) {
      if (!(error instanceof TransferJobError)) throw error
    }
  }
}

function emptyBatchRows(): AsyncIterable<TransferDataBatchRow> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true, value: undefined }
        },
      }
    },
  }
}
