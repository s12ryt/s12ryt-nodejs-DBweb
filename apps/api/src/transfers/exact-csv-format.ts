import {
  decodeMutationValue,
  isDatabaseValueType,
  type DatabaseValueType,
  type TaggedDatabaseValue,
} from '../data/tagged-value.js'

const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024
const BOM = '\ufeff'

export interface ExactCsvColumn {
  name: string
  type: DatabaseValueType
}

export interface ExactCsvSidecar {
  format: 'dbweb-exact-csv'
  version: 1
  schema: string
  table: string
  delimiter: ',' | '\t' | ';'
  bom: boolean
  columns: ExactCsvColumn[]
}

export type ExactCsvFormatErrorCode =
  | 'INVALID_EXACT_CSV'
  | 'CSV_HEADER_MISMATCH'
  | 'CSV_RECORD_TOO_LARGE'

export class ExactCsvFormatError extends Error {
  constructor(readonly code: ExactCsvFormatErrorCode) {
    super(code)
    this.name = 'ExactCsvFormatError'
  }
}

export async function* encodeExactCsv(
  sidecar: ExactCsvSidecar,
  rows: AsyncIterable<Record<string, TaggedDatabaseValue>>,
): AsyncIterable<Buffer> {
  const columns = validateSidecar(sidecar)
  const prefix = sidecar.bom ? BOM : ''
  yield Buffer.from(`${prefix}${columns.map((column) => encodeCell(column.name, sidecar.delimiter)).join(sidecar.delimiter)}\r\n`)
  for await (const row of rows) {
    validateRow(row, columns)
    const cells = columns.map((column) => encodeCell(JSON.stringify(row[column.name]), sidecar.delimiter))
    yield Buffer.from(`${cells.join(sidecar.delimiter)}\r\n`, 'utf8')
  }
}

export function decodeExactCsv(
  sidecar: ExactCsvSidecar,
  chunks: AsyncIterable<Uint8Array>,
  options: { maxRecordBytes?: number } = {},
): AsyncIterable<Record<string, TaggedDatabaseValue>> {
  const columns = validateSidecar(sidecar)
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) invalidCsv()

  return {
    async *[Symbol.asyncIterator]() {
      const records = parseCsv(chunks, sidecar.delimiter, maxRecordBytes)[Symbol.asyncIterator]()
      const first = await records.next()
      if (first.done) throw new ExactCsvFormatError('CSV_HEADER_MISMATCH')
      const header = first.value
      if (header[0]?.startsWith(BOM)) header[0] = header[0].slice(BOM.length)
      if (!sameStrings(header, columns.map((column) => column.name))) {
        throw new ExactCsvFormatError('CSV_HEADER_MISMATCH')
      }
      for (;;) {
        const next = await records.next()
        if (next.done) return
        if (next.value.length === 1 && next.value[0] === '') continue
        if (next.value.length !== columns.length) invalidCsv()
        const row: Record<string, TaggedDatabaseValue> = {}
        for (let index = 0; index < columns.length; index += 1) {
          const column = columns[index]!
          let parsed: unknown
          try {
            parsed = JSON.parse(next.value[index]!)
          } catch {
            invalidCsv()
          }
          validateTaggedValue(parsed, column.type)
          row[column.name] = parsed
        }
        yield row
      }
    },
  }
}

function validateSidecar(value: ExactCsvSidecar): ExactCsvColumn[] {
  if (
    value.format !== 'dbweb-exact-csv'
    || value.version !== 1
    || ![',', '\t', ';'].includes(value.delimiter)
    || typeof value.bom !== 'boolean'
    || !validName(value.schema)
    || !validName(value.table)
    || !Array.isArray(value.columns)
    || value.columns.length === 0
  ) invalidCsv()
  const names = new Set<string>()
  for (const column of value.columns) {
    if (
      !validName(column.name)
      || !isDatabaseValueType(column.type)
      || names.has(column.name)
    ) invalidCsv()
    names.add(column.name)
  }
  return value.columns
}

function validateRow(
  row: Record<string, TaggedDatabaseValue>,
  columns: ExactCsvColumn[],
): void {
  const names = columns.map((column) => column.name)
  if (!sameStrings(Object.keys(row), names)) invalidCsv()
  for (const column of columns) validateTaggedValue(row[column.name], column.type)
}

function validateTaggedValue(value: unknown, expectedType: DatabaseValueType): asserts value is TaggedDatabaseValue {
  if (!isRecord(value) || typeof value.kind !== 'string') invalidCsv()
  if (value.kind === 'null' || value.kind === 'default') {
    if (Object.keys(value).length !== 1) invalidCsv()
    return
  }
  if (
    value.kind !== 'value'
    || value.type !== expectedType
    || !Object.hasOwn(value, 'value')
    || Object.keys(value).length !== 3
  ) invalidCsv()
  try {
    decodeMutationValue(value as unknown as TaggedDatabaseValue)
  } catch {
    invalidCsv()
  }
}

async function* parseCsv(
  chunks: AsyncIterable<Uint8Array>,
  delimiter: string,
  maxRecordBytes: number,
): AsyncIterable<string[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let fields: string[] = []
  let field = ''
  let inQuotes = false
  let afterQuote = false
  let recordBytes = 0
  let skipLf = false

  const process = function* (text: string): Generator<string[]> {
    for (const character of text) {
      recordBytes += Buffer.byteLength(character)
      if (recordBytes > maxRecordBytes) throw new ExactCsvFormatError('CSV_RECORD_TOO_LARGE')
      if (skipLf) {
        skipLf = false
        if (character === '\n') continue
      }
      if (inQuotes) {
        if (afterQuote) {
          if (character === '"') {
            field += '"'
            afterQuote = false
            continue
          }
          inQuotes = false
          afterQuote = false
          if (character !== delimiter && character !== '\r' && character !== '\n') invalidCsv()
        } else if (character === '"') {
          afterQuote = true
          continue
        } else {
          field += character
          continue
        }
      } else if (character === '"') {
        if (field.length !== 0) invalidCsv()
        inQuotes = true
        continue
      }

      if (character === delimiter) {
        fields.push(field)
        field = ''
      } else if (character === '\r' || character === '\n') {
        fields.push(field)
        field = ''
        const completed = fields
        fields = []
        recordBytes = 0
        skipLf = character === '\r'
        yield completed
      } else {
        field += character
      }
    }
  }

  try {
    for await (const chunk of chunks) yield* process(decoder.decode(chunk, { stream: true }))
    yield* process(decoder.decode())
  } catch (error) {
    if (error instanceof ExactCsvFormatError) throw error
    invalidCsv()
  }
  if (inQuotes && !afterQuote) invalidCsv()
  if (afterQuote) inQuotes = false
  if (inQuotes) invalidCsv()
  if (field.length > 0 || fields.length > 0) {
    fields.push(field)
    yield fields
  }
}

function encodeCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value
}

function validName(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((value, index) => actual[index] === value)
}

function invalidCsv(): never {
  throw new ExactCsvFormatError('INVALID_EXACT_CSV')
}
