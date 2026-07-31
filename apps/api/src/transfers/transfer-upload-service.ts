import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { TransferChunkMetadata, TransferChunkStore } from './encrypted-chunk-store.js'
import type { TransferAuditRecorder } from './transfer-audit.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferJobError } from './transfer-job.js'

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/

export type TransferUploadErrorCode =
  | 'UPLOAD_NOT_ALLOWED'
  | 'UPLOAD_ALREADY_COMPLETED'
  | 'INCOMPLETE_UPLOAD'
  | 'FILE_SIZE_MISMATCH'
  | 'FILE_CHECKSUM_MISMATCH'

export class TransferUploadError extends Error {
  constructor(readonly code: TransferUploadErrorCode) {
    super(code)
    this.name = 'TransferUploadError'
  }
}

export type TransferUploadAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<boolean>

export class TransferUploadService {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly chunks: TransferChunkStore,
    private readonly chunkSizeBytes = 8 * 1024 * 1024,
    private readonly now: () => Date = () => new Date(),
    private readonly authorize: TransferUploadAuthorizer = async () => true,
    private readonly audit?: TransferAuditRecorder,
  ) {}

  async put(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    index: number,
    content: Uint8Array,
    checksum: string,
  ): Promise<TransferChunkMetadata> {
    const job = await this.jobs.get(actor, jobId)
    await this.requireAuthorized(actor, job)
    this.assertUploadOpen(job)
    const metadata = await this.chunks.put(jobId, index, content, checksum)
    const receivedBytes = (await this.chunks.list(jobId))
      .reduce((total, chunk) => total + chunk.size, 0)
    await this.jobs.update(actor, jobId, (job) => {
      this.assertUploadOpen(job)
      return { ...job, receivedBytes }
    })
    return metadata
  }

  async list(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
  ): Promise<TransferChunkMetadata[]> {
    await this.jobs.get(actor, jobId)
    return this.chunks.list(jobId)
  }

  async complete(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    expectedBytes: number,
    expectedChecksum: string,
  ): Promise<StoredTransferJob> {
    this.assertCompletionInput(expectedBytes, expectedChecksum)
    const job = await this.jobs.get(actor, jobId)
    await this.requireAuthorized(actor, job)
    this.assertUploadOpen(job)
    const chunks = await this.chunks.list(jobId)
    this.assertCompleteChunks(chunks)
    const receivedBytes = chunks.reduce((total, chunk) => total + chunk.size, 0)
    if (receivedBytes !== expectedBytes) throw new TransferUploadError('FILE_SIZE_MISMATCH')

    const hash = createHash('sha256')
    for (const chunk of chunks) hash.update(await this.chunks.read(jobId, chunk.index))
    if (hash.digest('hex') !== expectedChecksum) {
      throw new TransferUploadError('FILE_CHECKSUM_MISMATCH')
    }

    const completed = await this.jobs.update(actor, jobId, (job) => {
      this.assertUploadOpen(job)
      return {
        ...job,
        receivedBytes,
        sourceBytes: receivedBytes,
        sourceChecksum: expectedChecksum,
        uploadCompletedAt: this.now().toISOString(),
      }
    })
    await this.audit?.record({
      actorId: actor.id,
      jobId: completed.id,
      connectionId: completed.connectionId,
      direction: completed.direction,
      format: completed.format,
      action: 'upload-complete',
      status: 'success',
      details: { bytes: receivedBytes, checksum: expectedChecksum },
    })
    return completed
  }

  private assertUploadOpen(job: StoredTransferJob): void {
    if (job.direction !== 'import' || job.status !== 'queued') {
      throw new TransferUploadError('UPLOAD_NOT_ALLOWED')
    }
    if (job.uploadCompletedAt) throw new TransferUploadError('UPLOAD_ALREADY_COMPLETED')
  }

  private async requireAuthorized(
    actor: Pick<AuthUser, 'id' | 'role'>,
    job: StoredTransferJob,
  ): Promise<void> {
    if (!await this.authorize(actor, job)) throw new TransferJobError('FORBIDDEN')
  }

  private assertCompletionInput(expectedBytes: number, expectedChecksum: string): void {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw new TransferUploadError('FILE_SIZE_MISMATCH')
    }
    if (!CHECKSUM_PATTERN.test(expectedChecksum)) {
      throw new TransferUploadError('FILE_CHECKSUM_MISMATCH')
    }
  }

  private assertCompleteChunks(chunks: TransferChunkMetadata[]): void {
    if (chunks.length === 0) throw new TransferUploadError('INCOMPLETE_UPLOAD')
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      if (chunk.index !== index) throw new TransferUploadError('INCOMPLETE_UPLOAD')
      if (index < chunks.length - 1 && chunk.size !== this.chunkSizeBytes) {
        throw new TransferUploadError('INCOMPLETE_UPLOAD')
      }
    }
  }
}
