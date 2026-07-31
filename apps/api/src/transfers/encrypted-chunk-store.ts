import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EncryptionError, type EnvelopeEncryption } from '../security/envelope-encryption.js'

const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const CHUNK_FILE_PATTERN = /^(\d+)\.chunk$/
const CHUNK_MAGIC = Buffer.from('DCH1', 'ascii')
const CHUNK_HEADER_LENGTH = CHUNK_MAGIC.length + 4 + 64

export type TransferChunkErrorCode =
  | 'INVALID_CHUNK'
  | 'CHUNK_CHECKSUM_MISMATCH'
  | 'CHUNK_CONFLICT'
  | 'CHUNK_TOO_LARGE'
  | 'TRANSFER_TOO_LARGE'
  | 'CHUNK_NOT_FOUND'
  | 'CHUNK_CORRUPTED'

export class TransferChunkError extends Error {
  constructor(readonly code: TransferChunkErrorCode) {
    super(code)
    this.name = 'TransferChunkError'
  }
}

export interface TransferChunkMetadata {
  index: number
  size: number
  checksum: string
}

interface EncryptedChunkStoreOptions {
  root: string
  encryption: EnvelopeEncryption
  purposeNamespace?: string
  chunkSizeBytes?: number
  maxBytes?: number
}

export class EncryptedChunkStore {
  private readonly root: string
  private readonly encryption: EnvelopeEncryption
  private readonly purposeNamespace: string | undefined
  private readonly chunkSizeBytes: number
  private readonly maxBytes: number

  constructor(options: EncryptedChunkStoreOptions) {
    this.root = options.root
    this.encryption = options.encryption
    this.purposeNamespace = options.purposeNamespace
    this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(this.chunkSizeBytes) || this.chunkSizeBytes <= 0) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
    if (
      this.purposeNamespace !== undefined
      && !/^[a-z][a-z0-9-]{0,31}$/.test(this.purposeNamespace)
    ) throw new TransferChunkError('INVALID_CHUNK')
  }

  async put(
    jobId: string,
    index: number,
    plaintext: Uint8Array,
    expectedChecksum: string,
  ): Promise<TransferChunkMetadata> {
    this.validateCoordinates(jobId, index)
    const content = Buffer.from(plaintext)
    if (content.length > this.chunkSizeBytes) throw new TransferChunkError('CHUNK_TOO_LARGE')
    if ((index * this.chunkSizeBytes) + content.length > this.maxBytes) {
      throw new TransferChunkError('TRANSFER_TOO_LARGE')
    }
    if (!CHECKSUM_PATTERN.test(expectedChecksum)) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
    const checksum = createHash('sha256').update(content).digest('hex')
    if (checksum !== expectedChecksum) throw new TransferChunkError('CHUNK_CHECKSUM_MISMATCH')

    const directory = await this.ensureJobDirectory(jobId)
    const path = join(directory, `${index}.chunk`)
    const metadata = { index, size: content.length, checksum }
    const existing = await this.readHeaderIfPresent(path, index)
    if (existing) {
      if (existing.size === metadata.size && existing.checksum === metadata.checksum) return existing
      throw new TransferChunkError('CHUNK_CONFLICT')
    }

    const encrypted = this.encryption.encryptBytes(content, this.purpose(jobId, index))
    const stored = Buffer.concat([this.encodeHeader(metadata), encrypted])
    const temporaryPath = join(directory, `.${index}.${randomUUID()}.tmp`)
    await writeFile(temporaryPath, stored, { flag: 'wx', mode: 0o600 })
    try {
      await link(temporaryPath, path)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const concurrent = await this.readHeaderIfPresent(path, index)
      if (!concurrent || concurrent.size !== metadata.size || concurrent.checksum !== metadata.checksum) {
        throw new TransferChunkError('CHUNK_CONFLICT')
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
    return metadata
  }

  async read(jobId: string, index: number): Promise<Buffer> {
    this.validateCoordinates(jobId, index)
    const path = join(this.jobDirectory(jobId), `${index}.chunk`)
    try {
      const stored = await readFile(path)
      const metadata = this.decodeHeader(stored, index)
      const plaintext = this.encryption.decryptBytes(
        stored.subarray(CHUNK_HEADER_LENGTH),
        this.purpose(jobId, index),
      )
      if (plaintext.length !== metadata.size) throw new TransferChunkError('CHUNK_CORRUPTED')
      const checksum = createHash('sha256').update(plaintext).digest('hex')
      if (checksum !== metadata.checksum) throw new TransferChunkError('CHUNK_CORRUPTED')
      return plaintext
    } catch (error) {
      if (error instanceof TransferChunkError) throw error
      if (error instanceof EncryptionError) throw new TransferChunkError('CHUNK_CORRUPTED')
      if (isNotFound(error)) throw new TransferChunkError('CHUNK_NOT_FOUND')
      throw new TransferChunkError('CHUNK_CORRUPTED')
    }
  }

  async list(jobId: string): Promise<TransferChunkMetadata[]> {
    this.validateJobId(jobId)
    let files: string[]
    try {
      files = await readdir(this.jobDirectory(jobId))
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const chunks = await Promise.all(files.flatMap((file) => {
      const match = CHUNK_FILE_PATTERN.exec(file)
      if (!match) return []
      const index = Number(match[1])
      return [this.readHeaderIfPresent(join(this.jobDirectory(jobId), file), index)]
    }))
    return chunks.filter((chunk): chunk is TransferChunkMetadata => chunk !== undefined)
      .sort((left, right) => left.index - right.index)
  }

  async deleteJob(jobId: string): Promise<void> {
    this.validateJobId(jobId)
    await rm(this.jobDirectory(jobId), { recursive: true, force: true })
  }

  private validateCoordinates(jobId: string, index: number): void {
    this.validateJobId(jobId)
    if (!Number.isSafeInteger(index) || index < 0) throw new TransferChunkError('INVALID_CHUNK')
  }

  private validateJobId(jobId: string): void {
    if (!JOB_ID_PATTERN.test(jobId)) throw new TransferChunkError('INVALID_CHUNK')
  }

  private async ensureJobDirectory(jobId: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = this.jobDirectory(jobId)
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (!isAlreadyExists(error)) throw error
    })
    const stats = await lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TransferChunkError('INVALID_CHUNK')
    return directory
  }

  private jobDirectory(jobId: string): string {
    return join(this.root, jobId)
  }

  private purpose(jobId: string, index: number): string {
    return this.purposeNamespace
      ? `transfer-chunk:${this.purposeNamespace}:${jobId}:${index}`
      : `transfer-chunk:${jobId}:${index}`
  }

  private encodeHeader(metadata: TransferChunkMetadata): Buffer {
    const header = Buffer.alloc(CHUNK_HEADER_LENGTH)
    CHUNK_MAGIC.copy(header, 0)
    header.writeUInt32BE(metadata.size, CHUNK_MAGIC.length)
    header.write(metadata.checksum, CHUNK_MAGIC.length + 4, 64, 'ascii')
    return header
  }

  private decodeHeader(stored: Buffer, index: number): TransferChunkMetadata {
    if (stored.length < CHUNK_HEADER_LENGTH || !stored.subarray(0, CHUNK_MAGIC.length).equals(CHUNK_MAGIC)) {
      throw new TransferChunkError('CHUNK_CORRUPTED')
    }
    const size = stored.readUInt32BE(CHUNK_MAGIC.length)
    const checksum = stored.subarray(CHUNK_MAGIC.length + 4, CHUNK_HEADER_LENGTH).toString('ascii')
    if (size > this.chunkSizeBytes || !CHECKSUM_PATTERN.test(checksum)) {
      throw new TransferChunkError('CHUNK_CORRUPTED')
    }
    return { index, size, checksum }
  }

  private async readHeaderIfPresent(
    path: string,
    index: number,
  ): Promise<TransferChunkMetadata | undefined> {
    try {
      return this.decodeHeader(await readFile(path), index)
    } catch (error) {
      if (isNotFound(error)) return undefined
      if (error instanceof TransferChunkError) throw error
      throw new TransferChunkError('CHUNK_CORRUPTED')
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
