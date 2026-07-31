import type { DatabaseValueType } from '../data/tagged-value.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { DdlColumnDefinition } from '../ddl/ddl-command.js'
import { buildTransferColumnMapping } from './transfer-column-mapping.js'
import type { ExactJsonTable } from './exact-json-format.js'
import type { ExactJsonImportTablePlan } from './exact-json-import-service.js'
import { buildTransferImportPlan } from './transfer-import-plan.js'
import type { SqlDumpObject } from './sql-dump-manifest.js'
import { SqlRestoreExecutionError } from './sql-restore-service.js'

export function buildSqlRestoreDataPlan(
  object: SqlDumpObject,
  source: ExactJsonTable,
): ExactJsonImportTablePlan {
  if (object.kind !== 'table' || !object.schema || source.id !== object.id) changed()
  if (source.schema !== object.schema || source.table !== object.name) changed()
  const create = object.createCommands.find((command) => command.kind === 'create-table')
  if (!create || object.createCommands.filter((command) => command.kind === 'create-table').length !== 1) changed()
  const sourceByName = new Map(source.columns.map((column) => [column.name, column]))
  if (sourceByName.size !== source.columns.length || create.columns.length !== source.columns.length) changed()
  const columns = create.columns.map((column) => mutationColumn(column, sourceByName.get(column.name)?.type))
  const target: MutationTable = {
    schema: create.schema,
    name: create.name,
    columns,
    uniqueKeys: create.primaryKey?.length
      ? [{ name: 'PRIMARY', kind: 'primary', columns: [...create.primaryKey] }]
      : [],
  }
  const preserveIdentity = columns.some((column) =>
    column.generated && create.primaryKey?.includes(column.name))
  return {
    sourceId: source.id,
    source,
    target,
    mapping: buildTransferColumnMapping(
      source.columns,
      columns.map((column) => ({
        name: column.name,
        type: column.valueType as DatabaseValueType,
        nullable: column.nullable,
        generated: column.generated,
        hasDefault: column.hasDefault === true,
      })),
      [],
      { allowGeneratedTargets: preserveIdentity },
    ),
    conflict: buildTransferImportPlan(target, {
      conflict: 'skip', transaction: 'atomic', batchSize: 1_000, preserveIdentity,
    }),
  }
}

function mutationColumn(column: DdlColumnDefinition, sourceType: DatabaseValueType | undefined) {
  if (!sourceType || ddlValueType(column) !== sourceType) changed()
  return {
    name: column.name,
    valueType: sourceType,
    nullable: column.nullable,
    generated: column.identity === true || column.default?.kind === 'sequence',
    hasDefault: column.identity === true || column.default !== undefined,
  }
}

function ddlValueType(column: DdlColumnDefinition): DatabaseValueType {
  const name = column.type.name.trim().toLowerCase()
  if (name.endsWith('[]')) return 'array'
  if (['bigint', 'bigserial'].includes(name)) return 'bigint'
  if (['decimal', 'numeric'].includes(name)) return 'decimal'
  if (['smallint', 'integer', 'int', 'serial', 'real', 'float', 'double', 'double precision'].includes(name)) return 'number'
  if (['boolean', 'bool'].includes(name)) return 'boolean'
  if (name === 'date') return 'date'
  if (name === 'time' || name.startsWith('time(')) return 'time'
  if (['datetime', 'timestamp', 'timestamp without time zone'].includes(name)) return 'datetime'
  if (['timestamptz', 'timestamp with time zone'].includes(name)) return 'timestamptz'
  if (['bytea', 'binary', 'varbinary', 'blob'].includes(name)) return 'binary'
  if (['json', 'jsonb'].includes(name)) return 'json'
  if (name === 'uuid') return 'uuid'
  if (name === 'enum') return 'enum'
  if (['char', 'character', 'varchar', 'character varying', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(name)) {
    return 'string'
  }
  return changed()
}

function changed(): never {
  throw new SqlRestoreExecutionError('RESTORE_CHANGED')
}
