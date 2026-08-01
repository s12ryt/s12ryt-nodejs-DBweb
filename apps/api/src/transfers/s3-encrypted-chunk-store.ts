import { createHash } from 'node:crypto'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3'

import { EncryptionError, type EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  TransferChunkError,
  type TransferChunkMetadata,
  type TransferChunkStore,
} from './encrypted-chunk-store.js'

const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const CHUNK_MAGIC = Buffer.from('DCH1', 'ascii')
const CHUNK_HEADER_LENGTH = CHUNK_MAGIC.length + 4 + 64

export interface S3ChunkClient {
  send(command: unknown): Promise<unknown>
}

interface S3EncryptedChunkStoreOptions {
  client: S3ChunkClient
  bucket: string
  prefix?: string
  purposeNamespace: string
  encryption: EnvelopeEncryption
  chunkSizeBytes?: number
  maxBytes?: number
  serverSideEncryption?: ServerSideEncryption
  sseKmsKeyId?: string
}

interface GetObjectResult {
  Body?: { transformToByteArray(): Promise<Uint8Array> }
}

interface ListObjectsResult {
  Contents?: { Key?: string }[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

export class S3EncryptedChunkStore implements TransferChunkStore {
  private readonly prefix: string
  private readonly chunkSizeBytes: number
  private readonly maxBytes: number

  constructor(private readonly options: S3EncryptedChunkStoreOptions) {
    this.prefix = normalizePrefix(options.prefix)
    this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!options.bucket.trim() || options.bucket.length > 255) throw new TransferChunkError('INVALID_CHUNK')
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.purposeNamespace)) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
    if (!Number.isSafeInteger(this.chunkSizeBytes) || this.chunkSizeBytes <= 0) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TransferChunkError('INVALID_CHUNK')
    }
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
    if (!CHECKSUM_PATTERN.test(expectedChecksum)) throw new TransferChunkError('INVALID_CHUNK')
    const checksum = createHash('sha256').update(content).digest('hex')
    if (checksum !== expectedChecksum) throw new TransferChunkError('CHUNK_CHECKSUM_MISMATCH')
    const metadata = { index, size: content.length, checksum }
    const encrypted = this.options.encryption.encryptBytes(content, this.purpose(jobId, index))
    const stored = Buffer.concat([encodeHeader(metadata), encrypted])
    try {
      await this.options.client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(jobId, index),
        Body: stored,
        ContentLength: stored.length,
        ContentType: 'application/octet-stream',
        IfNoneMatch: '*',
        Metadata: { checksum, size: String(content.length) },
        ...(this.options.serverSideEncryption
          ? { ServerSideEncryption: this.options.serverSideEncryption }
          : {}),
        ...(this.options.sseKmsKeyId ? { SSEKMSKeyId: this.options.sseKmsKeyId } : {}),
      }))
      return metadata
    } catch (error) {
      if (!isPreconditionFailed(error)) throw new TransferChunkError('CHUNK_CORRUPTED')
      const existing = await this.readStored(jobId, index, false)
      if (existing.metadata.size === metadata.size && existing.metadata.checksum === metadata.checksum) {
        return existing.metadata
      }
      throw new TransferChunkError('CHUNK_CONFLICT')
    }
  }

  async read(jobId: string, index: number): Promise<Buffer> {
    return (await this.readStored(jobId, index, true)).plaintext!
  }

  async list(jobId: string): Promise<TransferChunkMetadata[]> {
    this.validateJobId(jobId)
    const prefix = this.jobPrefix(jobId)
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.options.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })) as ListObjectsResult
      for (const object of result.Contents ?? []) {
        if (object.Key && /^\d+\.chunk$/.test(object.Key.slice(prefix.length))) keys.push(object.Key)
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
      if (result.IsTruncated && !continuationToken) throw new TransferChunkError('CHUNK_CORRUPTED')
    } while (continuationToken)
    const chunks = await Promise.all(keys.map(async (key) => {
      const index = Number(key.slice(prefix.length, -'.chunk'.length))
      return (await this.readStored(jobId, index, false)).metadata
    }))
    return chunks.sort((left, right) => left.index - right.index)
  }

  async deleteJob(jobId: string): Promise<void> {
    this.validateJobId(jobId)
    const keys = await this.listKeys(this.jobPrefix(jobId))
    for (const key of keys) {
      await this.options.client.send(new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      }))
    }
  }

  private async readStored(
    jobId: string,
    index: number,
    decrypt: boolean,
  ): Promise<{ metadata: TransferChunkMetadata; plaintext?: Buffer }> {
    this.validateCoordinates(jobId, index)
    try {
      const result = await this.options.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(jobId, index),
      })) as GetObjectResult
      if (!result.Body) throw new TransferChunkError('CHUNK_CORRUPTED')
      const stored = Buffer.from(await result.Body.transformToByteArray())
      const metadata = decodeHeader(stored, index, this.chunkSizeBytes)
      if (!decrypt) return { metadata }
      const plaintext = this.options.encryption.decryptBytes(
        stored.subarray(CHUNK_HEADER_LENGTH),
        this.purpose(jobId, index),
      )
      if (plaintext.length !== metadata.size) throw new TransferChunkError('CHUNK_CORRUPTED')
      if (createHash('sha256').update(plaintext).digest('hex') !== metadata.checksum) {
        throw new TransferChunkError('CHUNK_CORRUPTED')
      }
      return { metadata, plaintext }
    } catch (error) {
      if (error instanceof TransferChunkError) throw error
      if (error instanceof EncryptionError) throw new TransferChunkError('CHUNK_CORRUPTED')
      if (isNotFound(error)) throw new TransferChunkError('CHUNK_NOT_FOUND')
      throw new TransferChunkError('CHUNK_CORRUPTED')
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.options.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })) as ListObjectsResult
      keys.push(...(result.Contents ?? []).flatMap((object) => object.Key ? [object.Key] : []))
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
      if (result.IsTruncated && !continuationToken) throw new TransferChunkError('CHUNK_CORRUPTED')
    } while (continuationToken)
    return keys
  }

  private validateCoordinates(jobId: string, index: number): void {
    this.validateJobId(jobId)
    if (!Number.isSafeInteger(index) || index < 0) throw new TransferChunkError('INVALID_CHUNK')
  }

  private validateJobId(jobId: string): void {
    if (!JOB_ID_PATTERN.test(jobId)) throw new TransferChunkError('INVALID_CHUNK')
  }

  private key(jobId: string, index: number): string {
    return `${this.jobPrefix(jobId)}${index}.chunk`
  }

  private jobPrefix(jobId: string): string {
    return `${this.prefix}${this.options.purposeNamespace}/${jobId}/`
  }

  private purpose(jobId: string, index: number): string {
    return `transfer-chunk:${this.options.purposeNamespace}:${jobId}:${index}`
  }
}

function normalizePrefix(value: string | undefined): string {
  if (!value?.trim()) return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\')) {
    throw new TransferChunkError('INVALID_CHUNK')
  }
  const segments = trimmed.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TransferChunkError('INVALID_CHUNK')
  }
  return `${trimmed}/`
}

function encodeHeader(metadata: TransferChunkMetadata): Buffer {
  const header = Buffer.alloc(CHUNK_HEADER_LENGTH)
  CHUNK_MAGIC.copy(header, 0)
  header.writeUInt32BE(metadata.size, CHUNK_MAGIC.length)
  header.write(metadata.checksum, CHUNK_MAGIC.length + 4, 64, 'ascii')
  return header
}

function decodeHeader(stored: Buffer, index: number, chunkSizeBytes: number): TransferChunkMetadata {
  if (stored.length < CHUNK_HEADER_LENGTH || !stored.subarray(0, CHUNK_MAGIC.length).equals(CHUNK_MAGIC)) {
    throw new TransferChunkError('CHUNK_CORRUPTED')
  }
  const size = stored.readUInt32BE(CHUNK_MAGIC.length)
  const checksum = stored.subarray(CHUNK_MAGIC.length + 4, CHUNK_HEADER_LENGTH).toString('ascii')
  if (size > chunkSizeBytes || !CHECKSUM_PATTERN.test(checksum)) {
    throw new TransferChunkError('CHUNK_CORRUPTED')
  }
  return { index, size, checksum }
}

function isPreconditionFailed(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'PreconditionFailed'
    || ('$metadata' in error
      && typeof error.$metadata === 'object'
      && error.$metadata !== null
      && 'httpStatusCode' in error.$metadata
      && error.$metadata.httpStatusCode === 412)
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'NoSuchKey'
    || ('$metadata' in error
      && typeof error.$metadata === 'object'
      && error.$metadata !== null
      && 'httpStatusCode' in error.$metadata
      && error.$metadata.httpStatusCode === 404)
  )
}
