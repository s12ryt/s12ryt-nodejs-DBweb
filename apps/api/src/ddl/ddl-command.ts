export type DdlErrorCode =
  | 'DDL_CAPABILITY_UNSUPPORTED'
  | 'DDL_COLUMN_DEFINITION_REQUIRED'
  | 'DDL_CONFIRMATION_REQUIRED'
  | 'DDL_INVALID_DEFAULT'
  | 'DDL_INVALID_FRAGMENT'
  | 'DDL_INVALID_IDENTIFIER'
  | 'DDL_INVALID_OPTION'
  | 'DDL_INVALID_TYPE_ARGUMENT'
  | 'DDL_TYPE_UNSUPPORTED'

export class DdlValidationError extends Error {
  constructor(readonly code: DdlErrorCode) {
    super(code)
    this.name = 'DdlValidationError'
  }
}

export type DdlDefault =
  | { kind: 'null' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'function'; name: string }

export interface DdlColumnType {
  name: string
  length?: number
  precision?: number
  scale?: number
  enumValues?: string[]
}

export interface DdlColumnDefinition {
  name: string
  type: DdlColumnType
  nullable: boolean
  identity?: boolean
  default?: DdlDefault
}

export interface DdlIndexPart {
  column?: string
  expression?: string
  order?: 'asc' | 'desc'
  prefixLength?: number
}

export type DdlReferentialAction = string

export type DdlConstraint =
  | { kind: 'primary-key'; columns: string[] }
  | { kind: 'unique'; columns: string[] }
  | {
      kind: 'foreign-key'
      columns: string[]
      referenceSchema: string
      referenceTable: string
      referenceColumns: string[]
      onDelete?: DdlReferentialAction
      onUpdate?: DdlReferentialAction
    }
  | { kind: 'check'; expression: string }

export type DdlCommand =
  | { kind: 'create-database'; name: string; owner?: string; encoding?: string; charset?: string; collation?: string }
  | { kind: 'rename-database'; from: string; to: string }
  | { kind: 'drop-database'; name: string; confirmed: boolean }
  | { kind: 'create-schema'; name: string; owner?: string }
  | { kind: 'rename-schema'; from: string; to: string }
  | { kind: 'drop-schema'; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-table'
      schema: string
      name: string
      columns: DdlColumnDefinition[]
      primaryKey?: string[]
      engine?: string
      charset?: string
      collation?: string
    }
  | { kind: 'rename-table'; schema: string; from: string; to: string }
  | { kind: 'drop-table'; schema: string; name: string; cascade?: boolean; confirmed: boolean }
  | { kind: 'add-column'; schema: string; table: string; column: DdlColumnDefinition }
  | {
      kind: 'rename-column'
      schema: string
      table: string
      from: string
      to: string
      definition?: DdlColumnDefinition
    }
  | { kind: 'drop-column'; schema: string; table: string; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-index'
      schema: string
      table: string
      name: string
      method: string
      unique: boolean
      parts: DdlIndexPart[]
      predicate?: string
      confirmed: boolean
    }
  | { kind: 'drop-index'; schema: string; table: string; name: string; confirmed: boolean }
  | {
      kind: 'add-constraint'
      schema: string
      table: string
      name: string
      constraint: DdlConstraint
      confirmed: boolean
    }
  | {
      kind: 'drop-constraint'
      schema: string
      table: string
      name: string
      constraintKind: DdlConstraint['kind']
      cascade?: boolean
      confirmed: boolean
    }
