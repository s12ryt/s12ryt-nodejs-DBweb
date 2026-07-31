import type { DatabaseValueType } from './tagged-value.js'

export interface MutationColumn {
  name: string
  valueType: DatabaseValueType | 'unsupported'
  nullable: boolean
  generated: boolean
}

export interface MutationUniqueKey {
  name: string
  kind: 'primary' | 'unique'
  columns: string[]
}

export interface MutationTable {
  schema: string
  name: string
  columns: MutationColumn[]
  uniqueKeys: MutationUniqueKey[]
}

export class RowWritePolicyError extends Error {
  constructor(readonly code: 'TABLE_WITHOUT_STABLE_KEY') {
    super(code)
    this.name = 'RowWritePolicyError'
  }
}

export interface RowWritePolicy {
  identity: MutationUniqueKey | null
  writableColumns: string[]
  readOnlyColumns: string[]
  canUpdate: boolean
  canDelete: boolean
  assertMutableRow(): void
}

export function buildRowWritePolicy(table: MutationTable): RowWritePolicy {
  const columnByName = new Map(table.columns.map((column) => [column.name, column]))
  const primary = table.uniqueKeys.find(
    (key) => key.kind === 'primary' && isStableKey(key, columnByName),
  )
  const unique = table.uniqueKeys.find(
    (key) => key.kind === 'unique' && isStableKey(key, columnByName),
  )
  const identity = primary ?? unique ?? null
  const writableColumns = table.columns
    .filter((column) => !column.generated && column.valueType !== 'unsupported')
    .map((column) => column.name)
  const readOnlyColumns = table.columns
    .filter((column) => column.generated || column.valueType === 'unsupported')
    .map((column) => column.name)

  return {
    identity,
    writableColumns,
    readOnlyColumns,
    canUpdate: identity !== null,
    canDelete: identity !== null,
    assertMutableRow() {
      if (!identity) throw new RowWritePolicyError('TABLE_WITHOUT_STABLE_KEY')
    },
  }
}

function isStableKey(
  key: MutationUniqueKey,
  columns: ReadonlyMap<string, MutationColumn>,
): boolean {
  return (
    key.columns.length > 0 &&
    key.columns.every((name) => {
      const column = columns.get(name)
      return column !== undefined && !column.nullable && column.valueType !== 'unsupported'
    })
  )
}
