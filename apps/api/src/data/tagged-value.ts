export type DatabaseValueType =
  | 'array'
  | 'bigint'
  | 'binary'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'decimal'
  | 'enum'
  | 'json'
  | 'number'
  | 'string'
  | 'time'
  | 'timestamptz'
  | 'uuid'

type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type TaggedDatabaseValue =
  | { kind: 'null' }
  | { kind: 'default' }
  | { kind: 'value'; type: 'array' | 'json'; value: JsonValue }
  | { kind: 'value'; type: 'boolean'; value: boolean }
  | { kind: 'value'; type: 'number'; value: number }
  | {
      kind: 'value'
      type:
        | 'bigint'
        | 'binary'
        | 'date'
        | 'datetime'
        | 'decimal'
        | 'enum'
        | 'string'
        | 'time'
        | 'timestamptz'
        | 'uuid'
      value: string
    }

export const DEFAULT_VALUE = Symbol('DBWEB_DEFAULT_VALUE')

type MutationValueErrorCode = 'INVALID_VALUE' | 'UNSUPPORTED_VALUE_TYPE'

export class MutationValueError extends Error {
  constructor(readonly code: MutationValueErrorCode) {
    super(code)
    this.name = 'MutationValueError'
  }
}

const STRING_TYPES = new Set<DatabaseValueType>([
  'date',
  'datetime',
  'decimal',
  'enum',
  'string',
  'time',
  'timestamptz',
  'uuid',
])

export function encodeDatabaseValue(value: unknown, type: string): TaggedDatabaseValue {
  if (!isDatabaseValueType(type)) throw new MutationValueError('UNSUPPORTED_VALUE_TYPE')
  if (value === null) return { kind: 'null' }

  if (type === 'bigint') {
    if (typeof value !== 'bigint' && typeof value !== 'string') invalidValue()
    const serialized = String(value)
    if (!isIntegerString(serialized)) invalidValue()
    return { kind: 'value', type, value: serialized }
  }
  if (type === 'binary') {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) invalidValue()
    return { kind: 'value', type, value: Buffer.from(value).toString('base64') }
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') invalidValue()
    return { kind: 'value', type, value }
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalidValue()
    return { kind: 'value', type, value }
  }
  if (type === 'array' || type === 'json') {
    if (!isJsonValue(value) || (type === 'array' && !Array.isArray(value))) invalidValue()
    return { kind: 'value', type, value }
  }
  if (typeof value !== 'string') invalidValue()
  return { kind: 'value', type, value }
}

export function decodeMutationValue(value: TaggedDatabaseValue): unknown | typeof DEFAULT_VALUE {
  if (value.kind === 'null') return null
  if (value.kind === 'default') return DEFAULT_VALUE

  switch (value.type) {
    case 'bigint':
      if (!isIntegerString(value.value)) invalidValue()
      return BigInt(value.value)
    case 'binary':
      if (!isCanonicalBase64(value.value)) invalidValue()
      return Buffer.from(value.value, 'base64')
    case 'number':
      if (!Number.isFinite(value.value)) invalidValue()
      return value.value
    case 'array':
      if (!Array.isArray(value.value) || !isJsonValue(value.value)) invalidValue()
      return value.value
    case 'json':
      if (!isJsonValue(value.value)) invalidValue()
      return value.value
    case 'boolean':
      return value.value
    default:
      if (!STRING_TYPES.has(value.type)) throw new MutationValueError('UNSUPPORTED_VALUE_TYPE')
      return value.value
  }
}

export function isDatabaseValueType(value: string): value is DatabaseValueType {
  return (
    value === 'array' ||
    value === 'bigint' ||
    value === 'binary' ||
    value === 'boolean' ||
    value === 'date' ||
    value === 'datetime' ||
    value === 'decimal' ||
    value === 'enum' ||
    value === 'json' ||
    value === 'number' ||
    value === 'string' ||
    value === 'time' ||
    value === 'timestamptz' ||
    value === 'uuid'
  )
}

function isIntegerString(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)$/.test(value)
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

function invalidValue(): never {
  throw new MutationValueError('INVALID_VALUE')
}
