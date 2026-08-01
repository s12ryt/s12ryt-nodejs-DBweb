import type { DatabaseEngine } from '../connections/connection-types.js'

export type KeysetCursorValue = string | number | boolean | null
export type KeysetDirection = 'forward' | 'backward'

export interface KeysetCursor {
  key: string[]
  values: KeysetCursorValue[]
  direction: KeysetDirection
}

export class KeysetPaginationError extends Error {
  constructor() {
    super('INVALID_KEYSET_CURSOR')
    this.name = 'KeysetPaginationError'
  }
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  validateCursor(cursor)
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url')
}

export function decodeKeysetCursor(value: string, expectedKey: string[]): KeysetCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new KeysetPaginationError()
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Record<string, unknown>
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new KeysetPaginationError()
    if (parsed.v !== 1 || !sameKeys(Object.keys(parsed), ['v', 'key', 'values', 'direction'])) {
      throw new KeysetPaginationError()
    }
    if (JSON.stringify(parsed) !== decoded) throw new KeysetPaginationError()
    const cursor = {
      key: parsed.key,
      values: parsed.values,
      direction: parsed.direction,
    } as KeysetCursor
    validateCursor(cursor)
    if (!sameKeys(cursor.key, expectedKey)) throw new KeysetPaginationError()
    return cursor
  } catch (error) {
    if (error instanceof KeysetPaginationError) throw error
    throw new KeysetPaginationError()
  }
}

export function buildKeysetPredicate(
  engine: DatabaseEngine,
  key: string[],
  values: KeysetCursorValue[],
  direction: KeysetDirection,
): { sql: string; values: KeysetCursorValue[]; orderBy: string; reverseResults: boolean } {
  validateCursor({ key, values, direction })
  const quote = engine === 'postgres' ? quotePostgres : quoteMysql
  const comparison = direction === 'forward' ? '>' : '<'
  const parameters: KeysetCursorValue[] = []
  const clauses = key.map((column, index) => {
    const equals = key.slice(0, index).map((priorColumn, priorIndex) => {
      parameters.push(values[priorIndex]!)
      return `${quote(priorColumn)} = ${placeholder(engine, parameters.length)}`
    })
    parameters.push(values[index]!)
    const comparisonClause = `${quote(column)} ${comparison} ${placeholder(engine, parameters.length)}`
    return `(${[...equals, comparisonClause].join(' AND ')})`
  })
  const order = direction === 'forward' ? 'ASC' : 'DESC'
  return {
    sql: clauses.join(' OR '),
    values: parameters,
    orderBy: key.map((column) => `${quote(column)} ${order}`).join(', '),
    reverseResults: direction === 'backward',
  }
}

function validateCursor(cursor: KeysetCursor): void {
  if (!Array.isArray(cursor.key) || cursor.key.length === 0 || cursor.key.length > 32) {
    throw new KeysetPaginationError()
  }
  if (!cursor.key.every((column) => typeof column === 'string' && column.length > 0)) {
    throw new KeysetPaginationError()
  }
  if (!Array.isArray(cursor.values) || cursor.values.length !== cursor.key.length) {
    throw new KeysetPaginationError()
  }
  if (!cursor.values.every(isCursorValue)) throw new KeysetPaginationError()
  if (cursor.direction !== 'forward' && cursor.direction !== 'backward') {
    throw new KeysetPaginationError()
  }
}

function isCursorValue(value: unknown): value is KeysetCursorValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function placeholder(engine: DatabaseEngine, index: number): string {
  return engine === 'postgres' ? `$${index}` : '?'
}

function quotePostgres(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteMysql(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}
