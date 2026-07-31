import { createHash } from 'node:crypto'

import type { DatabaseEngine } from '../connections/connection-types.js'
import {
  validateSqlDumpManifest,
  type SqlDumpEntry,
  type SqlDumpManifest,
} from './sql-dump-manifest.js'
import { readSafeTar, writeSafeTar, type SafeTarEntry } from './safe-tar.js'

const MANIFEST_PATH = 'manifest.json'
const MAX_MANIFEST_BYTES = 1024 * 1024

export interface SqlDumpPackageEntry {
  path: string
  size: number
  sha256: string
  content: AsyncIterable<Uint8Array>
}

export class SqlDumpPackageError extends Error {
  constructor(readonly code: 'INVALID_SQL_DUMP_PACKAGE' | 'SQL_DUMP_CHECKSUM_MISMATCH') {
    super(code)
    this.name = 'SqlDumpPackageError'
  }
}

export function writeSqlDumpPackage(
  manifestValue: SqlDumpManifest,
  entries: Iterable<SqlDumpPackageEntry> | AsyncIterable<SqlDumpPackageEntry>,
  options: { compression?: 'none' | 'gzip' } = {},
): AsyncIterable<Buffer> {
  return writePackage(manifestValue, entries, options.compression ?? 'none')
}

export async function readSqlDumpPackage(
  chunks: AsyncIterable<Uint8Array>,
  handler: (
    manifest: SqlDumpManifest,
    entry: SqlDumpEntry,
    content: AsyncIterable<Buffer>,
  ) => Promise<void>,
  options: { compression?: 'none' | 'gzip' } = {},
): Promise<{ manifest: SqlDumpManifest; entries: number }> {
  let manifest: SqlDumpManifest | undefined
  let entryIndex = 0
  let handlerError: unknown
  try {
    await readSafeTar(chunks, async (metadata, content) => {
      if (!manifest) {
        if (metadata.path !== MANIFEST_PATH || metadata.size > MAX_MANIFEST_BYTES) invalidPackage()
        const bytes = await collect(content, MAX_MANIFEST_BYTES)
        const parsed = parseJson(bytes)
        const engine = manifestEngine(parsed)
        manifest = validateSqlDumpManifest(parsed, engine)
        return
      }
      const expected = manifest.entries[entryIndex]
      if (!expected || metadata.path !== expected.path || metadata.size !== expected.size) invalidPackage()
      const verified = verifyContent(content, expected)
      try {
        await handler(manifest, expected, verified)
      } catch (error) {
        handlerError = error
        throw error
      }
      for await (const unread of verified) void unread
      entryIndex += 1
    }, { compression: options.compression ?? 'none' })
    if (!manifest || entryIndex !== manifest.entries.length) invalidPackage()
    return { manifest, entries: entryIndex }
  } catch (error) {
    if (handlerError !== undefined) throw handlerError
    if (error instanceof SqlDumpPackageError) throw error
    throw new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE')
  }
}

async function* writePackage(
  manifestValue: SqlDumpManifest,
  entries: Iterable<SqlDumpPackageEntry> | AsyncIterable<SqlDumpPackageEntry>,
  compression: 'none' | 'gzip',
): AsyncIterable<Buffer> {
  try {
    const manifest = validateSqlDumpManifest(manifestValue, manifestValue.engine)
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    if (manifestBytes.length > MAX_MANIFEST_BYTES) invalidPackage()
    const source = isAsyncIterable(entries)
      ? entries
      : toAsync(entries as Iterable<SqlDumpPackageEntry>)
    const iterator = source[Symbol.asyncIterator]()

    async function* tarEntries(): AsyncIterable<SafeTarEntry> {
      yield { path: MANIFEST_PATH, size: manifestBytes.length, content: toAsync([manifestBytes]) }
      for (const expected of manifest.entries) {
        const next = await iterator.next()
        if (next.done || !matchesEntry(next.value, expected)) invalidPackage()
        yield {
          path: expected.path,
          size: expected.size,
          content: verifyContent(next.value.content, expected),
        }
      }
      if (!(await iterator.next()).done) invalidPackage()
    }

    yield* writeSafeTar(tarEntries(), { compression })
  } catch (error) {
    if (error instanceof SqlDumpPackageError) throw error
    throw new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE')
  }
}

async function* verifyContent(
  chunks: AsyncIterable<Uint8Array>,
  expected: Pick<SqlDumpEntry, 'sha256' | 'size'>,
): AsyncIterable<Buffer> {
  const hash = createHash('sha256')
  let size = 0
  for await (const raw of chunks) {
    const chunk = Buffer.from(raw)
    size += chunk.length
    if (!Number.isSafeInteger(size) || size > expected.size) {
      throw new SqlDumpPackageError('SQL_DUMP_CHECKSUM_MISMATCH')
    }
    hash.update(chunk)
    yield chunk
  }
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
    throw new SqlDumpPackageError('SQL_DUMP_CHECKSUM_MISMATCH')
  }
}

function matchesEntry(actual: SqlDumpPackageEntry, expected: SqlDumpEntry): boolean {
  return actual.path === expected.path && actual.size === expected.size && actual.sha256 === expected.sha256
}

function manifestEngine(value: unknown): DatabaseEngine {
  if (typeof value === 'object' && value !== null && 'engine' in value) {
    const engine = (value as { engine?: unknown }).engine
    if (engine === 'postgres' || engine === 'mysql') return engine
  }
  return invalidPackage()
}

function parseJson(value: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
  } catch {
    return invalidPackage()
  }
}

async function collect(chunks: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const result: Buffer[] = []
  let size = 0
  for await (const chunk of chunks) {
    size += chunk.length
    if (size > limit) invalidPackage()
    result.push(chunk)
  }
  return Buffer.concat(result)
}

async function* toAsync<T>(values: Iterable<T>): AsyncIterable<T> {
  yield* values
}

function isAsyncIterable<T>(value: Iterable<T> | AsyncIterable<T>): value is AsyncIterable<T> {
  return Symbol.asyncIterator in value
}

function invalidPackage(): never {
  throw new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE')
}
