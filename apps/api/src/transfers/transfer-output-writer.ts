import { createHash } from 'node:crypto'

const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024

export type TransferOutputErrorCode =
  | 'INVALID_TRANSFER_OUTPUT'
  | 'TRANSFER_OUTPUT_CANCELLED'
  | 'TRANSFER_OUTPUT_FAILED'

export class TransferOutputError extends Error {
  constructor(readonly code: TransferOutputErrorCode) {
    super(code)
    this.name = 'TransferOutputError'
  }
}

export interface TransferOutputStore {
  put(
    jobId: string,
    index: number,
    plaintext: Uint8Array,
    expectedChecksum: string,
  ): Promise<unknown>
  deleteJob(jobId: string): Promise<void>
}

export interface TransferOutputResult {
  bytes: number
  chunks: number
  checksum: string
}

export class TransferOutputWriter {
  constructor(
    private readonly store: TransferOutputStore,
    private readonly chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES,
  ) {
    if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes < 1) {
      throw new TransferOutputError('INVALID_TRANSFER_OUTPUT')
    }
  }

  async write(
    jobId: string,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<TransferOutputResult> {
    const wholeHash = createHash('sha256')
    let pending = Buffer.alloc(0)
    let bytes = 0
    let index = 0

    await this.store.deleteJob(jobId)
    try {
      throwIfAborted(signal)
      for await (const rawChunk of chunks) {
        throwIfAborted(signal)
        const chunk = Buffer.from(rawChunk)
        wholeHash.update(chunk)
        bytes += chunk.length
        if (!Number.isSafeInteger(bytes)) throw new TransferOutputError('TRANSFER_OUTPUT_FAILED')

        let offset = 0
        if (pending.length > 0) {
          const needed = this.chunkSizeBytes - pending.length
          const take = Math.min(needed, chunk.length)
          pending = Buffer.concat([pending, chunk.subarray(0, take)])
          offset += take
          if (pending.length === this.chunkSizeBytes) {
            await this.put(jobId, index, pending)
            index += 1
            pending = Buffer.alloc(0)
          }
        }

        while (chunk.length - offset >= this.chunkSizeBytes) {
          const complete = chunk.subarray(offset, offset + this.chunkSizeBytes)
          await this.put(jobId, index, complete)
          index += 1
          offset += this.chunkSizeBytes
          throwIfAborted(signal)
        }
        if (offset < chunk.length) pending = Buffer.from(chunk.subarray(offset))
      }

      throwIfAborted(signal)
      if (pending.length > 0 || index === 0) {
        await this.put(jobId, index, pending)
        index += 1
      }
      return { bytes, chunks: index, checksum: wholeHash.digest('hex') }
    } catch (error) {
      await this.store.deleteJob(jobId).catch(() => undefined)
      if (error instanceof TransferOutputError) throw error
      throw new TransferOutputError('TRANSFER_OUTPUT_FAILED')
    }
  }

  async delete(jobId: string): Promise<void> {
    await this.store.deleteJob(jobId)
  }

  private async put(jobId: string, index: number, bytes: Buffer): Promise<void> {
    const checksum = createHash('sha256').update(bytes).digest('hex')
    await this.store.put(jobId, index, bytes, checksum)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferOutputError('TRANSFER_OUTPUT_CANCELLED')
}
