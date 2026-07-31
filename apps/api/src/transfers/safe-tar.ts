import { Readable } from 'node:stream'
import { createGunzip, createGzip } from 'node:zlib'

const BLOCK_SIZE = 512
const DEFAULT_MAX_ENTRY_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 10_000

export interface SafeTarEntry {
  path: string
  size: number
  content: AsyncIterable<Uint8Array>
}

export interface SafeTarEntryMetadata {
  path: string
  size: number
}

export type SafeTarErrorCode =
  | 'INVALID_TAR'
  | 'UNSAFE_TAR_PATH'
  | 'DUPLICATE_TAR_ENTRY'
  | 'UNSUPPORTED_TAR_ENTRY'
  | 'TAR_SIZE_MISMATCH'
  | 'TAR_LIMIT_EXCEEDED'

export class SafeTarError extends Error {
  constructor(readonly code: SafeTarErrorCode) {
    super(code)
    this.name = 'SafeTarError'
  }
}

interface SafeTarOptions {
  compression?: 'none' | 'gzip'
  maxEntryBytes?: number
  maxTotalBytes?: number
  maxEntries?: number
}

export function writeSafeTar(
  entries: Iterable<SafeTarEntry> | AsyncIterable<SafeTarEntry>,
  options: Pick<SafeTarOptions, 'compression'> = {},
): AsyncIterable<Buffer> {
  const raw = writeRawTar(entries)
  return options.compression === 'gzip' ? gzip(raw) : raw
}

export async function readSafeTar(
  chunks: AsyncIterable<Uint8Array>,
  handler: (
    entry: SafeTarEntryMetadata,
    content: AsyncIterable<Buffer>,
  ) => Promise<void>,
  options: SafeTarOptions = {},
): Promise<void> {
  const maxEntryBytes = positiveLimit(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES)
  const maxTotalBytes = positiveLimit(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
  const maxEntries = positiveLimit(options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const input = options.compression === 'gzip' ? gunzip(chunks) : chunks
  const reader = new ByteReader(input)
  const paths = new Set<string>()
  let totalBytes = 0
  let entries = 0

  try {
    for (;;) {
      const header = await reader.readExact(BLOCK_SIZE)
      if (!header) return
      if (isZeroBlock(header)) {
        const second = await reader.readExact(BLOCK_SIZE)
        if (!second || !isZeroBlock(second)) invalidTar()
        return
      }
      const metadata = decodeHeader(header)
      validatePath(metadata.path)
      if (paths.has(metadata.path)) throw new SafeTarError('DUPLICATE_TAR_ENTRY')
      paths.add(metadata.path)
      entries += 1
      totalBytes += metadata.size
      if (entries > maxEntries || metadata.size > maxEntryBytes || totalBytes > maxTotalBytes) {
        throw new SafeTarError('TAR_LIMIT_EXCEEDED')
      }

      let remaining = metadata.size
      const content: AsyncIterable<Buffer> = {
        async *[Symbol.asyncIterator]() {
          while (remaining > 0) {
            const block = await reader.readExact(Math.min(remaining, 64 * 1024))
            if (!block) invalidTar()
            remaining -= block.length
            yield block
          }
        },
      }
      await handler(metadata, content)
      for await (const unread of content) {
        void unread
        // Drain unread content so the next header remains aligned.
      }
      const padding = paddingFor(metadata.size)
      if (padding > 0 && !await reader.readExact(padding)) invalidTar()
    }
  } catch (error) {
    if (error instanceof SafeTarError) throw error
    throw new SafeTarError('INVALID_TAR')
  }
}

async function* writeRawTar(
  entries: Iterable<SafeTarEntry> | AsyncIterable<SafeTarEntry>,
): AsyncIterable<Buffer> {
  const paths = new Set<string>()
  for await (const entry of entries) {
    validatePath(entry.path)
    if (paths.has(entry.path)) throw new SafeTarError('DUPLICATE_TAR_ENTRY')
    paths.add(entry.path)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > DEFAULT_MAX_ENTRY_BYTES) {
      throw new SafeTarError('TAR_LIMIT_EXCEEDED')
    }
    yield encodeHeader(entry.path, entry.size)
    let written = 0
    for await (const chunk of entry.content) {
      const value = Buffer.from(chunk)
      written += value.length
      if (written > entry.size) throw new SafeTarError('TAR_SIZE_MISMATCH')
      if (value.length > 0) yield value
    }
    if (written !== entry.size) throw new SafeTarError('TAR_SIZE_MISMATCH')
    const padding = paddingFor(entry.size)
    if (padding > 0) yield Buffer.alloc(padding)
  }
  yield Buffer.alloc(BLOCK_SIZE * 2)
}

function encodeHeader(path: string, size: number): Buffer {
  const pathBytes = Buffer.byteLength(path)
  if (pathBytes > 100) throw new SafeTarError('UNSAFE_TAR_PATH')
  const header = Buffer.alloc(BLOCK_SIZE)
  header.write(path, 0, pathBytes, 'utf8')
  writeOctal(header, 100, 8, 0o600)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((total, value) => total + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function decodeHeader(header: Buffer): SafeTarEntryMetadata {
  const expectedChecksum = parseOctal(header.subarray(148, 156))
  let actualChecksum = 0
  for (let index = 0; index < header.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!
  }
  if (expectedChecksum !== actualChecksum) invalidTar()
  const type = header[156]
  if (type !== 0 && type !== 0x30) throw new SafeTarError('UNSUPPORTED_TAR_ENTRY')
  const name = readString(header.subarray(0, 100))
  const prefix = readString(header.subarray(345, 500))
  const path = prefix ? `${prefix}/${name}` : name
  const size = parseOctal(header.subarray(124, 136))
  if (!Number.isSafeInteger(size) || size < 0) invalidTar()
  return { path, size }
}

function validatePath(path: string): void {
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || Buffer.byteLength(path) > 255
  ) throw new SafeTarError('UNSAFE_TAR_PATH')
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SafeTarError('UNSAFE_TAR_PATH')
  }
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8)
  if (encoded.length > length - 1) throw new SafeTarError('TAR_LIMIT_EXCEEDED')
  buffer.write(`${encoded.padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function parseOctal(value: Buffer): number {
  const text = value.toString('ascii').replace(/[\0 ]+$/g, '')
  if (!/^[0-7]+$/.test(text)) invalidTar()
  return Number.parseInt(text, 8)
}

function readString(value: Buffer): string {
  const end = value.indexOf(0)
  const bytes = end === -1 ? value : value.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return invalidTar()
  }
}

function paddingFor(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
}

function isZeroBlock(value: Buffer): boolean {
  return value.every((byte) => byte === 0)
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new SafeTarError('TAR_LIMIT_EXCEEDED')
  return value
}

async function* gzip(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Buffer> {
  for await (const chunk of Readable.from(chunks).pipe(createGzip())) yield Buffer.from(chunk)
}

async function* gunzip(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Buffer> {
  for await (const chunk of Readable.from(chunks).pipe(createGunzip())) yield Buffer.from(chunk)
}

class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private pending = Buffer.alloc(0)
  private ended = false

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]()
  }

  async readExact(size: number): Promise<Buffer | undefined> {
    while (this.pending.length < size && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
      } else if (next.value.length > 0) {
        this.pending = Buffer.concat([this.pending, Buffer.from(next.value)])
      }
    }
    if (this.pending.length === 0 && this.ended) return undefined
    if (this.pending.length < size) invalidTar()
    const result = this.pending.subarray(0, size)
    this.pending = this.pending.subarray(size)
    return result
  }
}

function invalidTar(): never {
  throw new SafeTarError('INVALID_TAR')
}
