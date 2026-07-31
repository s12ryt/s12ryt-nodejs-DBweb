import type {
  DdlColumnDefinition,
  DdlConstraint,
  DdlIndexPart,
} from '../ddl/ddl-command.js'
import type { SqlDumpObject } from './sql-dump-manifest.js'

export interface SqlDumpTableConstraint {
  name: string
  constraint: DdlConstraint
}

export interface SqlDumpTableIndex {
  name: string
  method: string
  unique: boolean
  parts: DdlIndexPart[]
  predicate?: string
}

export interface SqlDumpTableDefinition {
  schema: string
  name: string
  columns: DdlColumnDefinition[]
  primaryKey?: string[]
  partitionBy?: { method: 'range' | 'list' | 'hash'; expression: string }
  constraints: SqlDumpTableConstraint[]
  indexes: SqlDumpTableIndex[]
  engine?: string
  charset?: string
  collation?: string
}

export class SqlDumpTableError extends Error {
  constructor(readonly code: 'INVALID_SQL_DUMP_TABLE') {
    super(code)
    this.name = 'SqlDumpTableError'
  }
}

export function buildSqlDumpTableObjects(
  table: SqlDumpTableDefinition,
  includeData: boolean,
): SqlDumpObject[] {
  validateTable(table)
  const tableId = tableObjectId(table.schema, table.name)
  const tableObject: SqlDumpObject = {
    id: tableId,
    kind: 'table',
    schema: table.schema,
    name: table.name,
    dependencies: [],
    createCommands: [{
      kind: 'create-table',
      schema: table.schema,
      name: table.name,
      columns: structuredClone(table.columns),
      ...(table.primaryKey ? { primaryKey: [...table.primaryKey] } : {}),
      ...(table.partitionBy ? { partitionBy: { ...table.partitionBy } } : {}),
      ...(table.engine ? { engine: table.engine } : {}),
      ...(table.charset ? { charset: table.charset } : {}),
      ...(table.collation ? { collation: table.collation } : {}),
    }],
    dropCommand: {
      kind: 'drop-table', schema: table.schema, name: table.name, confirmed: true,
    },
    ...(includeData ? { dataEntry: dataEntryPath(table.schema, table.name) } : {}),
  }

  const constraints = table.constraints.map(({ name, constraint }) => ({
    id: `constraint:${table.schema}.${table.name}.${name}`,
    kind: 'constraint' as const,
    schema: table.schema,
    name,
    dependencies: constraint.kind === 'foreign-key'
      ? unique([tableId, tableObjectId(constraint.referenceSchema, constraint.referenceTable)])
      : [tableId],
    createCommands: [{
      kind: 'add-constraint' as const,
      schema: table.schema,
      table: table.name,
      name,
      constraint: structuredClone(constraint),
      confirmed: true,
    }],
    dropCommand: {
      kind: 'drop-constraint' as const,
      schema: table.schema,
      table: table.name,
      name,
      constraintKind: constraint.kind,
      confirmed: true,
    },
  }))

  const indexes = table.indexes.map((index) => ({
    id: `index:${table.schema}.${table.name}.${index.name}`,
    kind: 'index' as const,
    schema: table.schema,
    name: index.name,
    dependencies: [tableId],
    createCommands: [{
      kind: 'create-index' as const,
      schema: table.schema,
      table: table.name,
      name: index.name,
      method: index.method,
      unique: index.unique,
      parts: structuredClone(index.parts),
      ...(index.predicate ? { predicate: index.predicate } : {}),
      confirmed: true,
    }],
    dropCommand: {
      kind: 'drop-index' as const,
      schema: table.schema,
      table: table.name,
      name: index.name,
      confirmed: true,
    },
  }))

  return [tableObject, ...constraints, ...indexes]
}

export function tableObjectId(schema: string, table: string): string {
  return `table:${schema}.${table}`
}

export function dataEntryPath(schema: string, table: string): string {
  return `data/${encodeURIComponent(schema)}.${encodeURIComponent(table)}.ndjson`
}

function validateTable(table: SqlDumpTableDefinition): void {
  if (!table.schema || !table.name || table.columns.length === 0) invalidTable()
  const columnNames = table.columns.map((column) => column.name)
  if (new Set(columnNames).size !== columnNames.length || columnNames.some((name) => !name)) invalidTable()
  if (table.primaryKey?.some((column) => !columnNames.includes(column))) invalidTable()
  if (table.primaryKey && new Set(table.primaryKey).size !== table.primaryKey.length) invalidTable()
  if (hasDuplicate(table.constraints.map(({ name }) => name)) || hasDuplicate(table.indexes.map(({ name }) => name))) {
    invalidTable()
  }
}

function hasDuplicate(values: string[]): boolean {
  return values.some((value) => !value) || new Set(values).size !== values.length
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function invalidTable(): never {
  throw new SqlDumpTableError('INVALID_SQL_DUMP_TABLE')
}
