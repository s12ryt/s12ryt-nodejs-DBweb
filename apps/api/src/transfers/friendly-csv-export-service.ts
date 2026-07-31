import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type {
  TransferDataGateway,
  TransferDataRow,
} from './transfer-data-gateway.js'
import { encodeFriendlyCsv } from './friendly-csv-format.js'
import type { TransferFilter } from './transfer-filter.js'
import {
  TransferJobError,
  type StoredTransferJob,
  type TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import type { TransferOutputResult, TransferOutputWriter } from './transfer-output-writer.js'

export interface FriendlyCsvExportPlan {
  table: MutationTable
  filters: TransferFilter[]
  delimiter: ',' | '\t' | ';'
  bom: boolean
  rawFormulaValues: boolean
  confirmedRawFormulaValues?: boolean
}

export interface FriendlyCsvPreviewValidator {
  validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<FriendlyCsvExportPlan>
}

export type FriendlyCsvExportAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export type FriendlyCsvExportErrorCode =
  | 'EXPORT_CANCELLED'
  | 'EXPORT_FAILED'
  | 'FORBIDDEN'
  | 'INVALID_EXPORT_JOB'

export class FriendlyCsvExportError extends Error {
  constructor(readonly code: FriendlyCsvExportErrorCode) {
    super(code)
    this.name = 'FriendlyCsvExportError'
  }
}

export class FriendlyCsvExportService {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, TransferDataGateway>,
    private readonly writer: Pick<TransferOutputWriter, 'delete' | 'write'>,
    private readonly preview: FriendlyCsvPreviewValidator,
    private readonly authorize: FriendlyCsvExportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    previewToken: string,
    signal = new AbortController().signal,
  ): Promise<TransferOutputResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new FriendlyCsvExportError('FORBIDDEN')
    if (job.direction !== 'export' || job.format !== 'csv' || job.status !== 'previewed') {
      throw new FriendlyCsvExportError('INVALID_EXPORT_JOB')
    }
    const plan = await this.preview.validate(actor, jobId, previewToken)
    const connection = await this.connections.resolveConnection(job.connectionId)
    const running = await this.jobs.update(actor, jobId, (current) =>
      transitionTransferJob(current, 'running', { updatedAt: this.now().toISOString() }))
    let processedRows = 0

    try {
      const rows = this.countRows(this.gateways[connection.engine].stream(connection, {
        table: plan.table,
        filters: plan.filters,
        batchSize: 1_000,
        signal,
      }), () => { processedRows += 1 })
      const output = encodeFriendlyCsv(
        plan.table.columns.map((column) => column.name),
        rows,
        {
          delimiter: plan.delimiter,
          bom: plan.bom,
          rawFormulaValues: plan.rawFormulaValues,
          ...(plan.confirmedRawFormulaValues === undefined
            ? {}
            : { confirmedRawFormulaValues: plan.confirmedRawFormulaValues }),
        },
      )
      const result = await this.writer.write(jobId, output, signal)
      if (signal.aborted) throw new FriendlyCsvExportError('EXPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: running.connectionId,
        direction: 'export',
        format: 'csv',
        action: 'export',
        status: 'success',
        details: { bytes: result.bytes, checksum: result.checksum },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(),
        processedBytes: current.processedBytes + result.bytes,
        processedRows: current.processedRows + processedRows,
        processedTables: current.processedTables + 1,
      }))
      return result
    } catch (error) {
      const cancelled = signal.aborted
        || (error instanceof FriendlyCsvExportError && error.code === 'EXPORT_CANCELLED')
      await this.writer.delete(jobId).catch(() => undefined)
      await this.markStopped(actor, jobId, cancelled ? 'cancelled' : 'failed')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: running.connectionId,
        direction: 'export',
        format: 'csv',
        action: 'export',
        status: 'failed',
        errorCode: cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
      }).catch(() => undefined)
      throw new FriendlyCsvExportError(cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED')
    }
  }

  private async *countRows(
    rows: AsyncIterable<TransferDataRow>,
    count: () => void,
  ): AsyncIterable<TransferDataRow> {
    for await (const row of rows) {
      count()
      yield row
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
