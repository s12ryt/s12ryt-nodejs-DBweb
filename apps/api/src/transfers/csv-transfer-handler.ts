import type { AuthUser } from '../auth/auth-types.js'
import type { StoredTransferJob } from './transfer-job.js'
import type { TransferPreviewInspection, TransferPreviewRequest } from './transfer-preview-service.js'

type Actor = Pick<AuthUser, 'id' | 'role'>

interface CsvJobService {
  get(actor: Actor, jobId: string): Promise<StoredTransferJob>
  cancel(actor: Actor, jobId: string): Promise<StoredTransferJob>
}

interface CsvPreviewPlanReader {
  validate(jobId: string, token: string): Promise<unknown>
}

export interface CsvTransferHandlerDelegate {
  inspect(actor: Actor, job: StoredTransferJob, request: TransferPreviewRequest): Promise<TransferPreviewInspection>
  execute(actor: Actor, jobId: string, token: string, signal?: AbortSignal): Promise<unknown>
  cancel(actor: Actor, jobId: string): Promise<StoredTransferJob>
}

export class CsvTransferHandlerError extends Error {
  constructor(readonly code: 'UNSUPPORTED_CSV_MODE') {
    super(code)
    this.name = 'CsvTransferHandlerError'
  }
}

export class CsvTransferHandler implements CsvTransferHandlerDelegate {
  private readonly active = new Map<string, CsvTransferHandlerDelegate>()

  constructor(
    private readonly jobs: CsvJobService,
    private readonly plans: CsvPreviewPlanReader,
    private readonly friendlyExport: CsvTransferHandlerDelegate,
    private readonly exactExport: CsvTransferHandlerDelegate,
    private readonly exactImport: CsvTransferHandlerDelegate,
  ) {}

  async inspect(actor: Actor, job: StoredTransferJob, request: TransferPreviewRequest): Promise<TransferPreviewInspection> {
    if (job.direction === 'import') {
      if (modeFromRequest(request) !== 'exact') unsupported()
      return this.exactImport.inspect(actor, job, request)
    }
    const mode = modeFromRequest(request)
    if (mode === 'friendly') return this.friendlyExport.inspect(actor, job, request)
    if (mode === 'exact') return this.exactExport.inspect(actor, job, request)
    return unsupported()
  }

  async execute(actor: Actor, jobId: string, token: string, signal?: AbortSignal): Promise<unknown> {
    const job = await this.jobs.get(actor, jobId)
    const delegate = job.direction === 'import'
      ? this.exactImport
      : this.exportDelegate(await this.plans.validate(jobId, token))
    if (this.active.has(jobId)) unsupported()
    this.active.set(jobId, delegate)
    try {
      return await delegate.execute(actor, jobId, token, signal)
    } finally {
      if (this.active.get(jobId) === delegate) this.active.delete(jobId)
    }
  }

  async cancel(actor: Actor, jobId: string): Promise<StoredTransferJob> {
    const active = this.active.get(jobId)
    if (active) return active.cancel(actor, jobId)
    return this.jobs.cancel(actor, jobId)
  }

  private exportDelegate(plan: unknown): CsvTransferHandlerDelegate {
    if (!isRecord(plan)) unsupported()
    if (plan.mode === 'friendly' || Object.hasOwn(plan, 'rawFormulaValues')) return this.friendlyExport
    if (plan.mode === 'exact' || (Object.hasOwn(plan, 'compression') && Object.hasOwn(plan, 'delimiter'))) return this.exactExport
    return unsupported()
  }
}

function modeFromRequest(request: TransferPreviewRequest): 'exact' | 'friendly' | undefined {
  if (!isRecord(request.strategy)) return undefined
  return request.strategy.mode === 'exact' || request.strategy.mode === 'friendly'
    ? request.strategy.mode
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unsupported(): never { throw new CsvTransferHandlerError('UNSUPPORTED_CSV_MODE') }
