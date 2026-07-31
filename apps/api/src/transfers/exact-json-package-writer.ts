import type { ExactJsonManifest, ExactJsonRecord } from './exact-json-format.js'
import { encodeExactJson } from './exact-json-format.js'
import { writeSafeTar } from './safe-tar.js'
import type { TransferOutputResult, TransferOutputWriter } from './transfer-output-writer.js'

export interface TransferStagedArtifactStore {
  list(jobId: string): Promise<Array<{ index: number; size: number }>>
  read(jobId: string, index: number): Promise<Buffer>
  deleteJob(jobId: string): Promise<void>
}

export type ExactJsonPackageErrorCode = 'EXACT_JSON_PACKAGE_FAILED'

export class ExactJsonPackageError extends Error {
  constructor(readonly code: ExactJsonPackageErrorCode) {
    super(code)
    this.name = 'ExactJsonPackageError'
  }
}

export class ExactJsonPackageWriter {
  constructor(
    private readonly stagingWriter: Pick<TransferOutputWriter, 'write'>,
    private readonly stagingStore: TransferStagedArtifactStore,
    private readonly outputWriter: Pick<TransferOutputWriter, 'delete' | 'write'>,
  ) {}

  async write(
    jobId: string,
    manifest: ExactJsonManifest,
    records: AsyncIterable<ExactJsonRecord>,
    options: { compression?: 'none' | 'gzip'; signal?: AbortSignal } = {},
  ): Promise<TransferOutputResult> {
    try {
      const staged = await this.stagingWriter.write(
        jobId,
        encodeExactJson(manifest, records),
        options.signal,
      )
      const content = this.readStaged(jobId, staged.chunks)
      const archive = writeSafeTar([{
        path: 'data.ndjson',
        size: staged.bytes,
        content,
      }], { compression: options.compression ?? 'none' })
      return await this.outputWriter.write(jobId, archive, options.signal)
    } catch {
      await Promise.allSettled([
        this.stagingStore.deleteJob(jobId),
        this.outputWriter.delete(jobId),
      ])
      throw new ExactJsonPackageError('EXACT_JSON_PACKAGE_FAILED')
    } finally {
      await this.stagingStore.deleteJob(jobId).catch(() => undefined)
    }
  }

  async delete(jobId: string): Promise<void> {
    await Promise.allSettled([
      this.stagingStore.deleteJob(jobId),
      this.outputWriter.delete(jobId),
    ])
  }

  private async *readStaged(jobId: string, expectedChunks: number): AsyncIterable<Buffer> {
    const chunks = await this.stagingStore.list(jobId)
    if (chunks.length !== expectedChunks) throw new ExactJsonPackageError('EXACT_JSON_PACKAGE_FAILED')
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index]?.index !== index) throw new ExactJsonPackageError('EXACT_JSON_PACKAGE_FAILED')
      yield await this.stagingStore.read(jobId, index)
    }
  }
}
