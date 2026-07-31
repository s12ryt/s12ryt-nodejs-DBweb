import type { AuthUser } from '../auth/auth-types.js'
import type {
  StoredTransferJob,
  TransferJobService,
} from './transfer-job.js'
import type {
  TransferPreviewInspection,
  TransferPreviewInspector,
  TransferPreviewRequest,
} from './transfer-preview-service.js'

type TransferActor = Pick<AuthUser, 'id' | 'role'>

export interface TransferExecutionHandler<TResult = unknown> {
  execute(actor: TransferActor, jobId: string, previewToken: string): Promise<TResult>
  cancel(actor: TransferActor, jobId: string): Promise<StoredTransferJob>
}

export interface TransferHandler extends TransferExecutionHandler, TransferPreviewInspector {}

export interface TransferHandlers {
  friendlyCsvExport: TransferHandler
  exactJsonExport: TransferHandler
  exactJsonImport: TransferHandler
  sqlDumpExport?: TransferHandler
  sqlRestore?: TransferHandler
}

export class TransferHandlerRouterError extends Error {
  constructor(readonly code: 'UNSUPPORTED_TRANSFER_HANDLER') {
    super(code)
    this.name = 'TransferHandlerRouterError'
  }
}

export class TransferHandlerRouter implements TransferHandler {
  constructor(
    private readonly jobs: Pick<TransferJobService, 'cancel' | 'get'>,
    private readonly handlers: TransferHandlers,
  ) {}

  inspect(
    actor: TransferActor,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    return this.handlerFor(job).inspect(actor, job, request)
  }

  async execute(actor: TransferActor, jobId: string, previewToken: string): Promise<unknown> {
    const job = await this.jobs.get(actor, jobId)
    return this.handlerFor(job).execute(actor, jobId, previewToken)
  }

  async cancel(actor: TransferActor, jobId: string): Promise<StoredTransferJob> {
    const job = await this.jobs.get(actor, jobId)
    return this.findHandler(job)?.cancel(actor, jobId) ?? this.jobs.cancel(actor, jobId)
  }

  private handlerFor(job: StoredTransferJob): TransferHandler {
    const handler = this.findHandler(job)
    if (handler) return handler
    throw new TransferHandlerRouterError('UNSUPPORTED_TRANSFER_HANDLER')
  }

  private findHandler(job: StoredTransferJob): TransferHandler | undefined {
    if (job.direction === 'export' && job.format === 'csv') return this.handlers.friendlyCsvExport
    if (job.direction === 'export' && job.format === 'json') return this.handlers.exactJsonExport
    if (job.direction === 'import' && job.format === 'json') return this.handlers.exactJsonImport
    if (job.direction === 'export' && job.format === 'sql') return this.handlers.sqlDumpExport
    if (job.direction === 'import' && job.format === 'sql') return this.handlers.sqlRestore
    return undefined
  }
}
