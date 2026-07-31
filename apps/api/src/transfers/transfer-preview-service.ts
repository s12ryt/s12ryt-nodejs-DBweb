import type { AuthUser } from '../auth/auth-types.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { transitionTransferJob } from './transfer-job.js'
import type { TransferPreviewFingerprint, TransferPreviewTokenService } from './transfer-preview-token.js'

export interface TransferPreviewRequest {
  mapping: Readonly<Record<string, unknown>>
  strategy: Readonly<Record<string, unknown>>
  target: Readonly<Record<string, unknown>>
}

export interface TransferPreviewIssue {
  line?: number
  column?: string
  code: string
  summary: string
}

export interface TransferPreviewInspection {
  fingerprint: TransferPreviewFingerprint
  estimatedBytes: number
  estimatedRows: number
  estimatedTables: number
  issues: TransferPreviewIssue[]
}

export interface TransferPreviewInspector {
  inspect(job: StoredTransferJob, request: TransferPreviewRequest): Promise<TransferPreviewInspection>
}

export type TransferPreviewServiceErrorCode = 'UPLOAD_INCOMPLETE' | 'INVALID_PREVIEW'

export class TransferPreviewError extends Error {
  constructor(readonly code: TransferPreviewServiceErrorCode) {
    super(code)
    this.name = 'TransferPreviewError'
  }
}

export interface TransferPreviewResult extends Omit<TransferPreviewInspection, 'fingerprint'> {
  token: string
}

export class TransferPreviewService {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly inspector: TransferPreviewInspector,
    private readonly tokens: TransferPreviewTokenService,
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async preview(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewResult> {
    const job = await this.jobs.get(actor, jobId)
    if (job.direction === 'import' && (!job.uploadCompletedAt || !job.sourceChecksum)) {
      throw new TransferPreviewError('UPLOAD_INCOMPLETE')
    }
    if (job.status !== 'queued') throw new TransferPreviewError('INVALID_PREVIEW')

    const inspection = await this.inspector.inspect(job, request)
    this.validateInspection(job, inspection)
    const token = this.tokens.issue(inspection.fingerprint)
    const previewed = await this.jobs.update(actor, jobId, (current) =>
      transitionTransferJob(current, 'previewed', { updatedAt: current.updatedAt }))
    await this.audit?.record({
      actorId: actor.id,
      jobId: previewed.id,
      connectionId: previewed.connectionId,
      direction: previewed.direction,
      format: previewed.format,
      action: 'preview',
      status: 'success',
      details: { bytes: inspection.estimatedBytes },
    })
    return {
      token,
      estimatedBytes: inspection.estimatedBytes,
      estimatedRows: inspection.estimatedRows,
      estimatedTables: inspection.estimatedTables,
      issues: structuredClone(inspection.issues),
    }
  }

  private validateInspection(job: StoredTransferJob, inspection: TransferPreviewInspection): void {
    if (inspection.fingerprint.jobId !== job.id) throw new TransferPreviewError('INVALID_PREVIEW')
    if (
      job.direction === 'import'
      && inspection.fingerprint.sourceChecksum !== job.sourceChecksum
    ) throw new TransferPreviewError('INVALID_PREVIEW')
    for (const value of [
      inspection.estimatedBytes,
      inspection.estimatedRows,
      inspection.estimatedTables,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TransferPreviewError('INVALID_PREVIEW')
    }
    if (inspection.issues.length > 100) throw new TransferPreviewError('INVALID_PREVIEW')
    for (const issue of inspection.issues) {
      if (!issue.code.trim() || !issue.summary.trim() || issue.summary.length > 1_000) {
        throw new TransferPreviewError('INVALID_PREVIEW')
      }
      if (issue.line !== undefined && (!Number.isSafeInteger(issue.line) || issue.line < 1)) {
        throw new TransferPreviewError('INVALID_PREVIEW')
      }
    }
  }
}
