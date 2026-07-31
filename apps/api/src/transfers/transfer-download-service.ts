import type { AuthUser } from '../auth/auth-types.js'
import type { EncryptedChunkStore } from './encrypted-chunk-store.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'

export type TransferDownloadErrorCode =
  | 'FORBIDDEN'
  | 'DOWNLOAD_NOT_READY'
  | 'OUTPUT_NOT_FOUND'

export class TransferDownloadError extends Error {
  constructor(readonly code: TransferDownloadErrorCode) {
    super(code)
    this.name = 'TransferDownloadError'
  }
}

export type TransferDownloadAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export interface TransferDownload {
  filename: string
  size: number
  stream: AsyncIterable<Buffer>
}

export class TransferDownloadService {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly output: EncryptedChunkStore,
    private readonly authorize: TransferDownloadAuthorizer,
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async open(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
  ): Promise<TransferDownload> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new TransferDownloadError('FORBIDDEN')
    if (job.direction !== 'export' || job.status !== 'succeeded') {
      throw new TransferDownloadError('DOWNLOAD_NOT_READY')
    }
    const chunks = await this.output.list(job.id)
    if (chunks.length === 0 || chunks.some((chunk, index) => chunk.index !== index)) {
      throw new TransferDownloadError('OUTPUT_NOT_FOUND')
    }
    const size = chunks.reduce((total, chunk) => total + chunk.size, 0)
    await this.audit?.record({
      actorId: actor.id,
      jobId: job.id,
      connectionId: job.connectionId,
      direction: job.direction,
      format: job.format,
      action: 'download',
      status: 'success',
      details: { bytes: size },
    })
    return {
      filename: `${job.id}.${job.format}`,
      size,
      stream: this.readChunks(job.id, chunks.map((chunk) => chunk.index)),
    }
  }

  private async *readChunks(jobId: string, indexes: readonly number[]): AsyncIterable<Buffer> {
    for (const index of indexes) yield await this.output.read(jobId, index)
  }
}
