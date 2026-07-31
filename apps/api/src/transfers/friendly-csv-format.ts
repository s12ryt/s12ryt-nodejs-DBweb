import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { TransferDataRow } from './transfer-data-gateway.js'

export type FriendlyCsvErrorCode =
  | 'FORMULA_CONFIRMATION_REQUIRED'
  | 'INVALID_FRIENDLY_CSV'

export class FriendlyCsvError extends Error {
  constructor(readonly code: FriendlyCsvErrorCode) {
    super(code)
    this.name = 'FriendlyCsvError'
  }
}

export interface FriendlyCsvOptions {
  delimiter: ',' | '\t' | ';'
  bom: boolean
  rawFormulaValues?: boolean
  confirmedRawFormulaValues?: boolean
}

export async function* encodeFriendlyCsv(
  columns: string[],
  rows: AsyncIterable<TransferDataRow>,
  options: FriendlyCsvOptions,
): AsyncIterable<Buffer> {
  validateColumns(columns)
  if (options.rawFormulaValues && !options.confirmedRawFormulaValues) {
    throw new FriendlyCsvError('FORMULA_CONFIRMATION_REQUIRED')
  }

  const protect = options.rawFormulaValues !== true
  const header = columns.map((column) => encodeCell(protectFormula(column, protect), options.delimiter))
  yield Buffer.from(`${options.bom ? '\uFEFF' : ''}${header.join(options.delimiter)}\r\n`)

  for await (const row of rows) {
    const keys = Object.keys(row)
    if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) invalidCsv()
    const cells = columns.map((column) => {
      if (!(column in row)) invalidCsv()
      const value = serializeFriendlyValue(row[column]!)
      return encodeCell(protectFormula(value, protect), options.delimiter)
    })
    yield Buffer.from(`${cells.join(options.delimiter)}\r\n`)
  }
}

function validateColumns(columns: string[]): void {
  if (columns.length === 0 || new Set(columns).size !== columns.length) invalidCsv()
  if (columns.some((column) => column.length === 0 || column.includes('\0'))) invalidCsv()
}

function serializeFriendlyValue(value: TaggedDatabaseValue): string {
  if (value.kind === 'null') return ''
  if (value.kind === 'default') invalidCsv()
  if (value.type === 'json' || value.type === 'array') return JSON.stringify(value.value)
  if (value.type === 'boolean' || value.type === 'number') return String(value.value)
  return String(value.value)
}

function protectFormula(value: string, enabled: boolean): string {
  if (!enabled) return value
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value
}

function encodeCell(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !/["\r\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function invalidCsv(): never {
  throw new FriendlyCsvError('INVALID_FRIENDLY_CSV')
}
