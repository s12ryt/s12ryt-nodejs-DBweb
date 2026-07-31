import {
  decodeMutationValue,
  isDatabaseValueType,
  type DatabaseValueType,
  type TaggedDatabaseValue,
} from '../data/tagged-value.js'

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

export interface ExactJsonColumn {
  name: string
  type: DatabaseValueType
}

export interface ExactJsonTable {
  id: string
  schema: string
  table: string
  columns: ExactJsonColumn[]
}

export interface ExactJsonManifest {
  kind: 'manifest'
  format: 'dbweb-exact-json'
  version: 1
  tables: ExactJsonTable[]
}

export interface ExactJsonRecord {
  kind: 'row'
  table: string
  values: Record<string, TaggedDatabaseValue>
}

export type ExactJsonFormatErrorCode =
  | 'INVALID_EXACT_JSON'
  | 'EXACT_JSON_LINE_TOO_LARGE'

export class ExactJsonFormatError extends Error {
  constructor(readonly code: ExactJsonFormatErrorCode) {
    super(code)
    this.name = 'ExactJsonFormatError'
  }
}

export async function* encodeExactJson(
  manifest: ExactJsonManifest,
  records: AsyncIterable<ExactJsonRecord>,
): AsyncIterable<Buffer> {
  const tables = validateManifest(manifest)
  yield encodeLine(manifest)
  for await (const record of records) {
    validateRecord(record, tables)
    yield encodeLine(record)
  }
}

export async function decodeExactJson(
  chunks: AsyncIterable<Uint8Array>,
  options: { maxLineBytes?: number } = {},
): Promise<{ manifest: ExactJsonManifest; records: AsyncIterable<ExactJsonRecord> }> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) invalidJson()
  const lines = readLines(chunks, maxLineBytes)[Symbol.asyncIterator]()
  const first = await lines.next()
  if (first.done) invalidJson()
  const manifest = parseJson(first.value)
  const tables = validateManifest(manifest)

  return {
    manifest: manifest as ExactJsonManifest,
    records: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = await lines.next()
          if (next.done) return
          if (next.value.length === 0) continue
          const record = parseJson(next.value)
          validateRecord(record, tables)
          yield record
        }
      },
    },
  }
}

function validateManifest(value: unknown): Map<string, ExactJsonTable> {
  if (!isRecord(value) || value.kind !== 'manifest' || value.format !== 'dbweb-exact-json') {
    invalidJson()
  }
  if (value.version !== 1 || !Array.isArray(value.tables) || value.tables.length === 0) {
    invalidJson()
  }
  if (!hasOnlyKeys(value, ['kind', 'format', 'version', 'tables'])) invalidJson()

  const tables = new Map<string, ExactJsonTable>()
  for (const candidate of value.tables) {
    if (
      !isRecord(candidate)
      || !hasOnlyKeys(candidate, ['id', 'schema', 'table', 'columns'])
      || !isNonEmptyString(candidate.id)
      || !isNonEmptyString(candidate.schema)
      || !isNonEmptyString(candidate.table)
      || !Array.isArray(candidate.columns)
      || candidate.columns.length === 0
      || tables.has(candidate.id)
    ) invalidJson()
    const names = new Set<string>()
    for (const column of candidate.columns) {
      if (
        !isRecord(column)
        || !hasOnlyKeys(column, ['name', 'type'])
        || !isNonEmptyString(column.name)
        || typeof column.type !== 'string'
        || !isDatabaseValueType(column.type)
        || names.has(column.name)
      ) invalidJson()
      names.add(column.name)
    }
    tables.set(candidate.id, candidate as unknown as ExactJsonTable)
  }
  return tables
}

function validateRecord(value: unknown, tables: ReadonlyMap<string, ExactJsonTable>): asserts value is ExactJsonRecord {
  if (
    !isRecord(value)
    || value.kind !== 'row'
    || !hasOnlyKeys(value, ['kind', 'table', 'values'])
    || typeof value.table !== 'string'
    || !isRecord(value.values)
  ) invalidJson()
  const table = tables.get(value.table)
  if (!table) invalidJson()
  const expected = new Map(table.columns.map((column) => [column.name, column.type]))
  if (Object.keys(value.values).length !== expected.size) invalidJson()
  for (const [name, tagged] of Object.entries(value.values)) {
    const type = expected.get(name)
    if (!type) invalidJson()
    validateTaggedValue(tagged, type)
  }
}

function validateTaggedValue(value: unknown, expectedType: DatabaseValueType): asserts value is TaggedDatabaseValue {
  if (!isRecord(value) || typeof value.kind !== 'string') invalidJson()
  if (value.kind === 'null' || value.kind === 'default') {
    if (!hasOnlyKeys(value, ['kind'])) invalidJson()
    return
  }
  if (
    value.kind !== 'value'
    || value.type !== expectedType
    || !hasOnlyKeys(value, ['kind', 'type', 'value'])
  ) invalidJson()
  try {
    decodeMutationValue(value as unknown as TaggedDatabaseValue)
  } catch {
    invalidJson()
  }
}

async function* readLines(
  chunks: AsyncIterable<Uint8Array>,
  maxLineBytes: number,
): AsyncIterable<string> {
  let pending = Buffer.alloc(0)
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, Buffer.from(chunk)])
    for (;;) {
      const newline = pending.indexOf(0x0a)
      if (newline === -1) break
      if (newline > maxLineBytes) throw new ExactJsonFormatError('EXACT_JSON_LINE_TOO_LARGE')
      let line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      yield decodeUtf8(line)
    }
    if (pending.length > maxLineBytes) throw new ExactJsonFormatError('EXACT_JSON_LINE_TOO_LARGE')
  }
  if (pending.length > 0) yield decodeUtf8(pending)
}

function encodeLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return invalidJson()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return invalidJson()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function invalidJson(): never {
  throw new ExactJsonFormatError('INVALID_EXACT_JSON')
}
