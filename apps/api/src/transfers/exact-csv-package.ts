import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import { decodeExactCsv, encodeExactCsv } from './exact-csv-format.js'
import type { TransferStagedArtifactStore } from './exact-json-package-writer.js'
import { readSafeTar, writeSafeTar } from './safe-tar.js'
import type { TransferOutputResult, TransferOutputWriter } from './transfer-output-writer.js'

const MAX_SIDECAR_BYTES = 1024 * 1024

export type ExactCsvPackageErrorCode =
  | 'EXACT_CSV_PACKAGE_FAILED'
  | 'INVALID_EXACT_CSV_PACKAGE'

export class ExactCsvPackageError extends Error {
  constructor(readonly code: ExactCsvPackageErrorCode) {
    super(code)
    this.name = 'ExactCsvPackageError'
  }
}

export { type TransferStagedArtifactStore }

export class ExactCsvPackageWriter {
  constructor(
    private readonly stagingWriter: Pick<TransferOutputWriter, 'write'>,
    private readonly stagingStore: TransferStagedArtifactStore,
    private readonly outputWriter: Pick<TransferOutputWriter, 'delete' | 'write'>,
  ) {}

  async write(
    jobId: string,
    sidecar: ExactCsvSidecar,
    rows: AsyncIterable<Record<string, TaggedDatabaseValue>>,
    options: { compression?: 'none' | 'gzip'; signal?: AbortSignal } = {},
  ): Promise<TransferOutputResult> {
    try {
      const staged = await this.stagingWriter.write(jobId, encodeExactCsv(sidecar, rows), options.signal)
      const sidecarBytes = Buffer.from(JSON.stringify(sidecar), 'utf8')
      if (sidecarBytes.length > MAX_SIDECAR_BYTES) throw new ExactCsvPackageError('EXACT_CSV_PACKAGE_FAILED')
      const archive = writeSafeTar([
        { path: 'sidecar.json', size: sidecarBytes.length, content: one(sidecarBytes) },
        { path: 'data.csv', size: staged.bytes, content: this.readStaged(jobId, staged.chunks) },
      ], { compression: options.compression ?? 'none' })
      return await this.outputWriter.write(jobId, archive, options.signal)
    } catch {
      await Promise.allSettled([
        this.stagingStore.deleteJob(jobId),
        this.outputWriter.delete(jobId),
      ])
      throw new ExactCsvPackageError('EXACT_CSV_PACKAGE_FAILED')
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
    if (chunks.length !== expectedChunks) throw new ExactCsvPackageError('EXACT_CSV_PACKAGE_FAILED')
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index]?.index !== index) throw new ExactCsvPackageError('EXACT_CSV_PACKAGE_FAILED')
      yield await this.stagingStore.read(jobId, index)
    }
  }
}

export async function readExactCsvPackage<T>(
  chunks: AsyncIterable<Uint8Array>,
  handler: (
    sidecar: ExactCsvSidecar,
    rows: AsyncIterable<Record<string, TaggedDatabaseValue>>,
  ) => Promise<T>,
  options: { compression?: 'none' | 'gzip' } = {},
): Promise<T> {
  let entryIndex = 0
  let sidecar: ExactCsvSidecar | undefined
  let result: T | undefined
  let handled = false
  let handlerError: unknown
  try {
    await readSafeTar(chunks, async (entry, content) => {
      entryIndex += 1
      if (entryIndex === 1) {
        if (entry.path !== 'sidecar.json' || entry.size > MAX_SIDECAR_BYTES) invalidPackage()
        sidecar = parseSidecar(await collectLimited(content, MAX_SIDECAR_BYTES))
        return
      }
      if (entryIndex !== 2 || entry.path !== 'data.csv' || !sidecar) invalidPackage()
      try {
        result = await handler(sidecar, decodeExactCsv(sidecar, content))
      } catch (error) {
        handlerError = error
        throw error
      }
      handled = true
    }, { compression: options.compression ?? 'none', maxEntries: 2 })
    if (entryIndex !== 2 || !handled) invalidPackage()
    return result as T
  } catch (error) {
    if (handlerError !== undefined) throw handlerError
    if (error instanceof ExactCsvPackageError) throw error
    throw new ExactCsvPackageError('INVALID_EXACT_CSV_PACKAGE')
  }
}

function parseSidecar(bytes: Buffer): ExactCsvSidecar {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    invalidPackage()
  }
  if (!isPlainObject(value)) invalidPackage()
  const keys = ['bom', 'columns', 'delimiter', 'format', 'schema', 'table', 'version']
  if (Object.keys(value).sort().some((key, index) => key !== keys[index])) invalidPackage()
  return value as unknown as ExactCsvSidecar
}

async function collectLimited(chunks: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const values: Buffer[] = []
  let size = 0
  for await (const chunk of chunks) {
    const value = Buffer.from(chunk)
    size += value.length
    if (size > limit) invalidPackage()
    values.push(value)
  }
  return Buffer.concat(values, size)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

async function* one(value: Buffer): AsyncIterable<Buffer> { yield value }

function invalidPackage(): never {
  throw new ExactCsvPackageError('INVALID_EXACT_CSV_PACKAGE')
}
