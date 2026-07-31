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

export interface DdlRoutineArgument {
  name?: string
  mode?: 'in' | 'out' | 'inout'
  type: DdlColumnType
}

export type DdlEventSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; amount: number; unit: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' }

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
  | { kind: 'create-view'; schema: string; name: string; query: string; replace?: boolean; confirmed: boolean }
  | { kind: 'drop-view'; schema: string; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-materialized-view'
      schema: string
      name: string
      query: string
      withData: boolean
      confirmed: boolean
    }
  | {
      kind: 'refresh-materialized-view'
      schema: string
      name: string
      concurrently?: boolean
      confirmed: boolean
    }
  | { kind: 'drop-materialized-view'; schema: string; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-sequence'
      schema: string
      name: string
      start?: number
      increment?: number
      minValue?: number
      maxValue?: number
      cache?: number
      cycle?: boolean
    }
  | { kind: 'drop-sequence'; schema: string; name: string; cascade?: boolean; confirmed: boolean }
  | { kind: 'create-enum'; schema: string; name: string; values: string[] }
  | {
      kind: 'create-domain'
      schema: string
      name: string
      baseType: DdlColumnType
      nullable: boolean
      default?: DdlDefault
      check?: string
      confirmed: boolean
    }
  | { kind: 'drop-type'; schema: string; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-extension'
      name: string
      schema?: string
      version?: string
      cascade?: boolean
      confirmed: boolean
    }
  | { kind: 'drop-extension'; name: string; cascade?: boolean; confirmed: boolean }
  | {
      kind: 'create-routine'
      routineKind: 'function' | 'procedure'
      schema: string
      name: string
      arguments: DdlRoutineArgument[]
      returns?: DdlColumnType
      returnsSet?: boolean
      language?: string
      body: string
      replace?: boolean
      volatility?: 'volatile' | 'stable' | 'immutable'
      security?: 'invoker' | 'definer'
      strict?: boolean
      deterministic?: boolean
      dataAccess?: 'no-sql' | 'contains-sql' | 'reads-sql-data' | 'modifies-sql-data'
      confirmed: boolean
    }
  | {
      kind: 'drop-routine'
      routineKind: 'function' | 'procedure'
      schema: string
      name: string
      argumentTypes: DdlColumnType[]
      cascade?: boolean
      confirmed: boolean
    }
  | {
      kind: 'create-trigger'
      schema: string
      table: string
      name: string
      timing: 'before' | 'after' | 'instead-of'
      events: Array<'insert' | 'update' | 'delete' | 'truncate'>
      forEach: 'row' | 'statement'
      when?: string
      functionSchema?: string
      functionName?: string
      functionArguments?: string[]
      body?: string
      confirmed: boolean
    }
  | { kind: 'drop-trigger'; schema: string; table: string; name: string; confirmed: boolean }
  | {
      kind: 'create-event'
      schema: string
      name: string
      schedule: DdlEventSchedule
      preserve: boolean
      enabled: boolean
      body: string
      confirmed: boolean
    }
  | { kind: 'drop-event'; schema: string; name: string; confirmed: boolean }
  | {
      kind: 'create-partition'
      schema: string
      table: string
      name: string
      definition: string
      confirmed: boolean
    }
  | { kind: 'drop-partition'; schema: string; table: string; name: string; confirmed: boolean }
