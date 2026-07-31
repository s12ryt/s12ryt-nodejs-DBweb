import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import { applyTransferMapping, type TransferColumnMappingPlan } from './transfer-column-mapping.js'
import type { ExactJsonRecord, ExactJsonTable } from './exact-json-format.js'
import { readExactJsonPackage } from './exact-json-package-reader.js'
import type { TransferImportPlan } from './transfer-import-plan.js'
import {
  TransferJobError,
  type StoredTransferJob,
  type TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'

export interface ExactJsonImportTablePlan {
  sourceId: string
  source: ExactJsonTable
  target: MutationTable
  mapping: TransferColumnMappingPlan
  conflict: TransferImportPlan
}

export interface ExactJsonImportPlan {
  compression: 'none' | 'gzip'
  transaction: 'atomic' | 'batch'
  batchSize: number
  tables: ExactJsonImportTablePlan[]
}

export interface ExactJsonImportRow {
  sourceId: string
  values: Record<string, TaggedDatabaseValue>
}

export interface ExactJsonImportResult {
  processedRows: number
  insertedRows: number
  updatedRows: number
  skippedRows: number
  batches: number
}

export type ExactJsonImportGatewayErrorCode = 'IMPORT_DATA_CANCELLED' | 'IMPORT_DATA_FAILED'

export class ExactJsonImportGatewayError extends Error {
  constructor(
    readonly code: ExactJsonImportGatewayErrorCode,
    readonly progress: ExactJsonImportResult,
  ) {
    super(code)
    this.name = 'ExactJsonImportGatewayError'
  }
}

export interface ExactJsonImportGateway {
  execute(
    connection: ResolvedConnection,
    request: {
      transaction: 'atomic' | 'batch'
      batchSize: number
      tables: ExactJsonImportTablePlan[]
      rows: AsyncIterable<ExactJsonImportRow>
      signal: AbortSignal
    },
  ): Promise<ExactJsonImportResult>
}

export interface ExactJsonImportPreviewValidator {
  validate(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string, token: string): Promise<ExactJsonImportPlan>
}

export interface TransferSourcePackageStore {
  stream(jobId: string): AsyncIterable<Buffer>
}

export type ExactJsonImportAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export type ExactJsonImportErrorCode =
  | 'FORBIDDEN'
  | 'IMPORT_CANCELLED'
  | 'IMPORT_FAILED'
  | 'INVALID_IMPORT_JOB'

export class ExactJsonImportError extends Error {
  constructor(readonly code: ExactJsonImportErrorCode) {
    super(code)
    this.name = 'ExactJsonImportError'
  }
}

export class ExactJsonImportService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; finish(): void }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, ExactJsonImportGateway>,
    private readonly source: TransferSourcePackageStore,
    private readonly preview: ExactJsonImportPreviewValidator,
    private readonly authorize: ExactJsonImportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    previewToken: string,
    externalSignal = new AbortController().signal,
  ): Promise<ExactJsonImportResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new ExactJsonImportError('FORBIDDEN')
    if (
      job.direction !== 'import' || job.format !== 'json' || job.status !== 'previewed'
      || !job.uploadCompletedAt || !job.sourceChecksum
    ) throw new ExactJsonImportError('INVALID_IMPORT_JOB')
    const plan = this.validatePlan(await this.preview.validate(actor, jobId, previewToken))
    const connection = await this.connections.resolveConnection(job.connectionId)
    if (this.active.has(jobId)) throw new ExactJsonImportError('INVALID_IMPORT_JOB')
    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.active.set(jobId, { controller, done, finish })

    try {
      await this.jobs.update(actor, jobId, (current) =>
        transitionTransferJob(current, 'running', { updatedAt: this.now().toISOString() }))
      const result = await readExactJsonPackage(
        this.source.stream(jobId),
        async (manifest, records) => {
          this.validateManifest(manifest.tables, plan.tables)
          return this.gateways[connection.engine].execute(connection, {
            transaction: plan.transaction,
            batchSize: plan.batchSize,
            tables: plan.tables,
            rows: this.mapRows(records, plan.tables),
            signal,
          })
        },
        { compression: plan.compression },
      )
      if (signal.aborted) throw new ExactJsonImportError('IMPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id, jobId, connectionId: job.connectionId,
        direction: 'import', format: 'json', action: 'import', status: 'success',
        details: { bytes: job.sourceBytes ?? 0 },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(),
        processedBytes: current.processedBytes + (current.sourceBytes ?? 0),
        processedRows: current.processedRows + result.processedRows,
        processedTables: current.processedTables + plan.tables.length,
      }))
      return result
    } catch (error) {
      const cancelled = signal.aborted
        || (error instanceof ExactJsonImportError && error.code === 'IMPORT_CANCELLED')
        || (error instanceof ExactJsonImportGatewayError && error.code === 'IMPORT_DATA_CANCELLED')
      await this.markStopped(
        actor,
        jobId,
        cancelled ? 'cancelled' : 'failed',
        error instanceof ExactJsonImportGatewayError ? error.progress : undefined,
      )
      await this.audit?.record({
        actorId: actor.id, jobId, connectionId: job.connectionId,
        direction: 'import', format: 'json', action: 'import', status: 'failed',
        errorCode: cancelled ? 'IMPORT_CANCELLED' : 'IMPORT_FAILED',
      }).catch(() => undefined)
      throw new ExactJsonImportError(cancelled ? 'IMPORT_CANCELLED' : 'IMPORT_FAILED')
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

  private validatePlan(plan: ExactJsonImportPlan): ExactJsonImportPlan {
    if (
      plan.tables.length === 0 || plan.tables.length > 100
      || new Set(plan.tables.map((item) => item.sourceId)).size !== plan.tables.length
      || !Number.isSafeInteger(plan.batchSize) || plan.batchSize < 100 || plan.batchSize > 10_000
    ) throw new ExactJsonImportError('INVALID_IMPORT_JOB')
    return plan
  }

  private validateManifest(actual: ExactJsonTable[], expected: ExactJsonImportTablePlan[]): void {
    if (actual.length !== expected.length) throw new ExactJsonImportError('IMPORT_FAILED')
    const byId = new Map(actual.map((table) => [table.id, table]))
    for (const item of expected) {
      if (JSON.stringify(byId.get(item.sourceId)) !== JSON.stringify(item.source)) {
        throw new ExactJsonImportError('IMPORT_FAILED')
      }
    }
  }

  private async *mapRows(
    records: AsyncIterable<ExactJsonRecord>,
    tables: ExactJsonImportTablePlan[],
  ): AsyncIterable<ExactJsonImportRow> {
    const byId = new Map(tables.map((table) => [table.sourceId, table]))
    for await (const record of records) {
      const table = byId.get(record.table)
      if (!table) throw new ExactJsonImportError('IMPORT_FAILED')
      yield { sourceId: record.table, values: applyTransferMapping(record.values, table.mapping) }
    }
  }

  private async markStopped(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    status: 'cancelled' | 'failed',
    progress?: ExactJsonImportResult,
  ): Promise<void> {
    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, status, {
        updatedAt: this.now().toISOString(),
        ...(progress ? { processedRows: current.processedRows + progress.processedRows } : {}),
        ...(status === 'failed' ? { errorCount: current.errorCount + 1 } : {}),
      }))
    } catch (error) {
      if (!(error instanceof TransferJobError)) throw error
    }
  }
}
