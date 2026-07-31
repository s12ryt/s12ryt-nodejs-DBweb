import {
  decodeMutationValue,
  type DatabaseValueType,
  type TaggedDatabaseValue,
} from '../data/tagged-value.js'

export interface TransferSourceColumn {
  name: string
  type: DatabaseValueType
}

export interface TransferTargetColumn {
  name: string
  type: DatabaseValueType
  nullable: boolean
  generated: boolean
  hasDefault: boolean
}

export type TransferColumnMappingInput =
  | { source: string; target: string; ignore?: never }
  | { source: string; ignore: true; target?: never }

export interface TransferColumnMappingPlan {
  mapped: Array<{ source: string; target: string; type: DatabaseValueType }>
  missing: Array<{ target: string; value: TaggedDatabaseValue }>
  ignored: string[]
}

export class TransferMappingError extends Error {
  constructor(readonly code: 'INVALID_TRANSFER_MAPPING') {
    super(code)
    this.name = 'TransferMappingError'
  }
}

export function buildTransferColumnMapping(
  sourceColumns: TransferSourceColumn[],
  targetColumns: TransferTargetColumn[],
  overrides: TransferColumnMappingInput[],
  options: { allowGeneratedTargets?: boolean } = {},
): TransferColumnMappingPlan {
  const sources = uniqueByName(sourceColumns)
  const targets = uniqueByName(targetColumns)
  const overrideBySource = new Map<string, TransferColumnMappingInput>()
  for (const override of overrides) {
    if (!sources.has(override.source) || overrideBySource.has(override.source)) invalidMapping()
    overrideBySource.set(override.source, override)
  }

  const mapped: TransferColumnMappingPlan['mapped'] = []
  const ignored: string[] = []
  const usedTargets = new Set<string>()
  for (const source of sourceColumns) {
    const override = overrideBySource.get(source.name)
    if (override && 'ignore' in override) {
      ignored.push(source.name)
      continue
    }
    const targetName = override?.target ?? (targets.has(source.name) ? source.name : undefined)
    if (!targetName) invalidMapping()
    const target = targets.get(targetName)
    if (
      !target
      || (target.generated && options.allowGeneratedTargets !== true)
      || target.type !== source.type
      || usedTargets.has(target.name)
    ) {
      invalidMapping()
    }
    usedTargets.add(target.name)
    mapped.push({ source: source.name, target: target.name, type: target.type })
  }

  const missing: TransferColumnMappingPlan['missing'] = []
  for (const target of targetColumns) {
    if (target.generated || usedTargets.has(target.name)) continue
    if (target.hasDefault) {
      missing.push({ target: target.name, value: { kind: 'default' } })
    } else if (target.nullable) {
      missing.push({ target: target.name, value: { kind: 'null' } })
    } else {
      invalidMapping()
    }
  }

  return { mapped, missing, ignored }
}

export function applyTransferMapping(
  row: Record<string, TaggedDatabaseValue>,
  plan: TransferColumnMappingPlan,
): Record<string, TaggedDatabaseValue> {
  const expectedSources = [...plan.mapped.map((entry) => entry.source), ...plan.ignored]
  if (!sameNames(Object.keys(row), expectedSources)) invalidMapping()

  const result: Record<string, TaggedDatabaseValue> = {}
  for (const entry of plan.mapped) {
    const value = row[entry.source]
    if (!value) invalidMapping()
    validateTaggedValue(value, entry.type)
    result[entry.target] = structuredClone(value)
  }
  for (const source of plan.ignored) validateTaggedValue(row[source])
  for (const entry of plan.missing) result[entry.target] = structuredClone(entry.value)
  return result
}

function uniqueByName<T extends { name: string }>(values: T[]): Map<string, T> {
  if (!Array.isArray(values) || values.length === 0) invalidMapping()
  const result = new Map<string, T>()
  for (const value of values) {
    if (!validName(value.name) || result.has(value.name)) invalidMapping()
    result.set(value.name, value)
  }
  return result
}

function validateTaggedValue(value: TaggedDatabaseValue | undefined, type?: DatabaseValueType): void {
  if (!value || (value.kind === 'value' && type !== undefined && value.type !== type)) invalidMapping()
  try {
    decodeMutationValue(value)
  } catch {
    invalidMapping()
  }
}

function sameNames(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((name) => actual.includes(name))
}

function validName(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function invalidMapping(): never {
  throw new TransferMappingError('INVALID_TRANSFER_MAPPING')
}
