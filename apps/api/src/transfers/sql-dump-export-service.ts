import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferJobError, transitionTransferJob } from './transfer-job.js'
import type { SqlDumpManifest, SqlDumpScope } from './sql-dump-manifest.js'
import type {
  SqlDumpEntrySource,
  SqlDumpPackageWriteResult,
  SqlDumpPackageWriter,
} from './sql-dump-package-writer.js'
import type { TransferOutputResult } from './transfer-output-writer.js'

type TransferActor = Pick<AuthUser, 'id' | 'role'>

export interface SqlDumpExportPlan {
  compression: 'none' | 'gzip'
  scope: SqlDumpScope
  includeData: boolean
}

export interface SqlDumpExportCatalogResult {
  manifest: Omit<SqlDumpManifest, 'entries'>
  entries: SqlDumpEntrySource[]
  rows: number
  tables: number
}

export interface SqlDumpExportCatalog {
  withSnapshot<T>(
    connection: ResolvedConnection,
    plan: SqlDumpExportPlan,
    signal: AbortSignal,
    consume: (catalog: SqlDumpExportCatalogResult) => Promise<T>,
  ): Promise<T>
}

export interface SqlDumpExportPreviewValidator {
  validate(actor: TransferActor, jobId: string, token: string): Promise<SqlDumpExportPlan>
}

export type SqlDumpExportAuthorizer = (actor: TransferActor, job: StoredTransferJob) => Promise<boolean>

export type SqlDumpExportErrorCode = 'EXPORT_CANCELLED' | 'EXPORT_FAILED' | 'FORBIDDEN' | 'INVALID_EXPORT_JOB'

export class SqlDumpExportError extends Error {
  constructor(readonly code: SqlDumpExportErrorCode) {
    super(code)
    this.name = 'SqlDumpExportError'
  }
}

export class SqlDumpExportService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; finish(): void }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly catalogs: Record<DatabaseEngine, SqlDumpExportCatalog>,
    private readonly packages: Pick<SqlDumpPackageWriter, 'delete' | 'write'>,
    private readonly preview: SqlDumpExportPreviewValidator,
    private readonly authorize: SqlDumpExportAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async execute(
    actor: TransferActor,
    jobId: string,
    previewToken: string,
    externalSignal = new AbortController().signal,
  ): Promise<TransferOutputResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new SqlDumpExportError('FORBIDDEN')
    if (job.direction !== 'export' || job.format !== 'sql' || job.status !== 'previewed') {
      throw new SqlDumpExportError('INVALID_EXPORT_JOB')
    }
    const plan = await this.preview.validate(actor, jobId, previewToken)
    if (plan.includeData !== job.includeData || this.active.has(jobId)) {
      throw new SqlDumpExportError('INVALID_EXPORT_JOB')
    }
    const connection = await this.connections.resolveConnection(job.connectionId)
    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.active.set(jobId, { controller, done, finish })

    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'running', {
        updatedAt: this.now().toISOString(),
      }))
      const completed = await this.catalogs[connection.engine].withSnapshot(connection, plan, signal, async (catalog) => {
        this.validateCatalog(connection, plan, catalog)
        const packaged = await this.packages.write(jobId, catalog.manifest, catalog.entries, {
          compression: plan.compression,
          signal,
        })
        return { catalog, packaged }
      })
      if (signal.aborted) throw new SqlDumpExportError('EXPORT_CANCELLED')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: job.connectionId,
        direction: 'export',
        format: 'sql',
        action: 'export',
        status: 'success',
        details: { bytes: completed.packaged.bytes, checksum: completed.packaged.checksum },
      })
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(),
        processedBytes: current.processedBytes + completed.packaged.bytes,
        processedRows: current.processedRows + completed.catalog.rows,
        processedTables: current.processedTables + completed.catalog.tables,
      }))
      return outputResult(completed.packaged)
    } catch (error) {
      const cancelled = signal.aborted
        || (error instanceof SqlDumpExportError && error.code === 'EXPORT_CANCELLED')
      await this.packages.delete(jobId).catch(() => undefined)
      await this.markStopped(actor, jobId, cancelled ? 'cancelled' : 'failed')
      await this.audit?.record({
        actorId: actor.id,
        jobId,
        connectionId: job.connectionId,
        direction: 'export',
        format: 'sql',
        action: 'export',
        status: 'failed',
        errorCode: cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
      }).catch(() => undefined)
      throw new SqlDumpExportError(cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED')
    } finally {
      const active = this.active.get(jobId)
      if (active?.controller === controller) {
        this.active.delete(jobId)
        active.finish()
      }
    }
  }

  async cancel(actor: TransferActor, jobId: string): Promise<StoredTransferJob> {
    await this.jobs.get(actor, jobId)
    const active = this.active.get(jobId)
    if (!active) return this.jobs.cancel(actor, jobId)
    active.controller.abort()
    await active.done
    return this.jobs.get(actor, jobId)
  }

  private validateCatalog(
    connection: ResolvedConnection,
    plan: SqlDumpExportPlan,
    catalog: SqlDumpExportCatalogResult,
  ): void {
    if (
      catalog.manifest.engine !== connection.engine
      || catalog.manifest.database !== connection.database
      || JSON.stringify(catalog.manifest.scope) !== JSON.stringify(plan.scope)
      || !Number.isSafeInteger(catalog.rows)
      || catalog.rows < 0
      || !Number.isSafeInteger(catalog.tables)
      || catalog.tables < 0
    ) throw new SqlDumpExportError('INVALID_EXPORT_JOB')
  }

  private async markStopped(actor: TransferActor, jobId: string, status: 'failed' | 'cancelled'): Promise<void> {
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

function outputResult(value: SqlDumpPackageWriteResult): TransferOutputResult {
  return { bytes: value.bytes, chunks: value.chunks, checksum: value.checksum }
}
