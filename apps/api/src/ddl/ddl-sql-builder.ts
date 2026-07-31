import type { DdlCapabilities } from './ddl-capabilities.js'
import {
  DdlValidationError,
  type DdlColumnDefinition,
  type DdlColumnType,
  type DdlCommand,
  type DdlConstraint,
  type DdlDefault,
  type DdlIndexPart,
} from './ddl-command.js'

const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/
const MYSQL_ENGINES = new Set(['innodb', 'myisam', 'memory'])
const DEFAULT_FUNCTIONS = new Map([
  ['current_timestamp', 'CURRENT_TIMESTAMP'],
  ['current_date', 'CURRENT_DATE'],
  ['current_time', 'CURRENT_TIME'],
])

export function buildDdlStatements(
  capabilities: DdlCapabilities,
  command: DdlCommand,
): string[] {
  const quote = capabilities.engine === 'postgres' ? quotePostgres : quoteMysql
  const qualified = (schema: string, name: string) => `${quoteName(schema, quote)}.${quoteName(name, quote)}`

  switch (command.kind) {
    case 'create-database': {
      const name = quoteName(command.name, quote)
      if (capabilities.engine === 'postgres') {
        const owner = command.owner ? ` OWNER ${quoteName(command.owner, quote)}` : ''
        const encoding = command.encoding ? ` ENCODING ${quoteLiteralToken(command.encoding)}` : ''
        return [`CREATE DATABASE ${name}${owner}${encoding}`]
      }
      const charset = command.charset ? ` CHARACTER SET ${safeToken(command.charset)}` : ''
      const collation = command.collation ? ` COLLATE ${safeToken(command.collation)}` : ''
      return [`CREATE DATABASE ${name}${charset}${collation}`]
    }
    case 'rename-database':
      requireCapability(capabilities.database.rename)
      return [`ALTER DATABASE ${quoteName(command.from, quote)} RENAME TO ${quoteName(command.to, quote)}`]
    case 'drop-database':
      requireConfirmation(command.confirmed)
      return [`DROP DATABASE ${quoteName(command.name, quote)}`]
    case 'create-schema': {
      if (capabilities.schema.databaseAlias) {
        return [`CREATE DATABASE ${quoteName(command.name, quote)}`]
      }
      const owner = command.owner ? ` AUTHORIZATION ${quoteName(command.owner, quote)}` : ''
      return [`CREATE SCHEMA ${quoteName(command.name, quote)}${owner}`]
    }
    case 'rename-schema':
      requireCapability(capabilities.schema.rename)
      return [`ALTER SCHEMA ${quoteName(command.from, quote)} RENAME TO ${quoteName(command.to, quote)}`]
    case 'drop-schema':
      requireConfirmation(command.confirmed)
      return capabilities.schema.databaseAlias
        ? [`DROP DATABASE ${quoteName(command.name, quote)}`]
        : [`DROP SCHEMA ${quoteName(command.name, quote)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-table': {
      if (command.columns.length === 0) throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
      const columns = command.columns.map((column) => renderColumn(capabilities, column, quote))
      const options = capabilities.engine === 'mysql'
        ? renderMysqlTableOptions(command.engine, command.charset, command.collation)
        : requireNoStorageOptions(command.engine, command.charset, command.collation)
      return [`CREATE TABLE ${qualified(command.schema, command.name)} (${columns.join(', ')})${options}`]
    }
    case 'rename-table':
      return capabilities.engine === 'postgres'
        ? [`ALTER TABLE ${qualified(command.schema, command.from)} RENAME TO ${quoteName(command.to, quote)}`]
        : [`RENAME TABLE ${qualified(command.schema, command.from)} TO ${qualified(command.schema, command.to)}`]
    case 'drop-table':
      requireConfirmation(command.confirmed)
      return [`DROP TABLE ${qualified(command.schema, command.name)}${capabilities.engine === 'postgres' && command.cascade ? ' CASCADE' : ''}`]
    case 'add-column':
      return [`ALTER TABLE ${qualified(command.schema, command.table)} ADD COLUMN ${renderColumn(capabilities, command.column, quote)}`]
    case 'rename-column': {
      if (capabilities.column.renameSyntax === 'change-column') {
        if (!command.definition) throw new DdlValidationError('DDL_COLUMN_DEFINITION_REQUIRED')
        if (command.definition.name !== command.to) throw new DdlValidationError('DDL_INVALID_IDENTIFIER')
        return [`ALTER TABLE ${qualified(command.schema, command.table)} CHANGE COLUMN ${quoteName(command.from, quote)} ${renderColumn(capabilities, command.definition, quote)}`]
      }
      return [`ALTER TABLE ${qualified(command.schema, command.table)} RENAME COLUMN ${quoteName(command.from, quote)} TO ${quoteName(command.to, quote)}`]
    }
    case 'drop-column':
      requireConfirmation(command.confirmed)
      return [`ALTER TABLE ${qualified(command.schema, command.table)} DROP COLUMN ${quoteName(command.name, quote)}${capabilities.engine === 'postgres' && command.cascade ? ' CASCADE' : ''}`]
    case 'create-index': {
      const method = command.method.toLowerCase()
      if (!capabilities.index.methods.includes(method)) {
        throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
      }
      if (command.unique && (capabilities.engine === 'postgres' ? method !== 'btree' : method === 'fulltext')) {
        throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
      }
      if (command.parts.length === 0) throw new DdlValidationError('DDL_INVALID_OPTION')
      const advanced = method !== 'btree'
        || command.parts.some((part) => part.expression !== undefined)
        || command.predicate !== undefined
      if (advanced) requireConfirmation(command.confirmed)
      if (command.predicate && !capabilities.index.partial) {
        throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
      }
      const parts = command.parts.map((part) => renderIndexPart(capabilities, part, quote)).join(', ')
      const predicate = command.predicate ? ` WHERE ${safeFragment(command.predicate)}` : ''
      const unique = command.unique ? ' UNIQUE' : ''
      if (capabilities.engine === 'postgres') {
        return [`CREATE${unique} INDEX ${quoteName(command.name, quote)} ON ${qualified(command.schema, command.table)} USING ${method} (${parts})${predicate}`]
      }
      const mysqlMethod = method === 'fulltext' ? 'FULLTEXT' : command.unique ? 'UNIQUE' : ''
      const using = method === 'fulltext' ? '' : ` USING ${method.toUpperCase()}`
      return [`CREATE${mysqlMethod ? ` ${mysqlMethod}` : ''} INDEX ${quoteName(command.name, quote)}${using} ON ${qualified(command.schema, command.table)} (${parts})`]
    }
    case 'drop-index':
      requireConfirmation(command.confirmed)
      return capabilities.engine === 'postgres'
        ? [`DROP INDEX ${qualified(command.schema, command.name)}`]
        : [`DROP INDEX ${quoteName(command.name, quote)} ON ${qualified(command.schema, command.table)}`]
    case 'add-constraint': {
      if (command.constraint.kind !== 'unique') requireConfirmation(command.confirmed)
      const definition = renderConstraint(capabilities, command.constraint, quote, qualified)
      return [`ALTER TABLE ${qualified(command.schema, command.table)} ADD CONSTRAINT ${quoteName(command.name, quote)} ${definition}`]
    }
    case 'drop-constraint':
      requireConfirmation(command.confirmed)
      if (capabilities.engine === 'postgres') {
        return [`ALTER TABLE ${qualified(command.schema, command.table)} DROP CONSTRAINT ${quoteName(command.name, quote)}${command.cascade ? ' CASCADE' : ''}`]
      }
      requireCapability(capabilities.constraint[constraintCapabilityKey(command.constraintKind)])
      return [`ALTER TABLE ${qualified(command.schema, command.table)} ${renderMysqlDropConstraint(command.constraintKind, command.name, quote)}`]
  }
}

function renderIndexPart(
  capabilities: DdlCapabilities,
  part: DdlIndexPart,
  quote: (value: string) => string,
): string {
  if ((part.column === undefined) === (part.expression === undefined)) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  if (part.expression !== undefined && !capabilities.index.expression) {
    throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  }
  if (part.prefixLength !== undefined && !capabilities.index.prefixLength) {
    throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  }
  if (part.prefixLength !== undefined && !validInteger(part.prefixLength, 1, 65_535)) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  const target = part.column === undefined
    ? `(${safeFragment(part.expression ?? '')})`
    : `${quoteName(part.column, quote)}${part.prefixLength === undefined ? '' : `(${part.prefixLength})`}`
  return `${target}${part.order ? ` ${part.order.toUpperCase()}` : ''}`
}

function renderConstraint(
  capabilities: DdlCapabilities,
  constraint: DdlConstraint,
  quote: (value: string) => string,
  qualified: (schema: string, name: string) => string,
): string {
  if (constraint.kind === 'check') {
    requireCapability(capabilities.constraint.check)
    return `CHECK (${safeFragment(constraint.expression)})`
  }
  const columns = renderNameList(constraint.columns, quote)
  if (constraint.kind === 'primary-key') {
    requireCapability(capabilities.constraint.primaryKey)
    return `PRIMARY KEY (${columns})`
  }
  if (constraint.kind === 'unique') {
    requireCapability(capabilities.constraint.unique)
    return `UNIQUE (${columns})`
  }
  requireCapability(capabilities.constraint.foreignKey)
  if (constraint.columns.length !== constraint.referenceColumns.length) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  const referenceColumns = renderNameList(constraint.referenceColumns, quote)
  const onDelete = constraint.onDelete ? ` ON DELETE ${referentialAction(capabilities, constraint.onDelete)}` : ''
  const onUpdate = constraint.onUpdate ? ` ON UPDATE ${referentialAction(capabilities, constraint.onUpdate)}` : ''
  return `FOREIGN KEY (${columns}) REFERENCES ${qualified(constraint.referenceSchema, constraint.referenceTable)} (${referenceColumns})${onDelete}${onUpdate}`
}

function renderNameList(values: string[], quote: (value: string) => string): string {
  if (values.length === 0) throw new DdlValidationError('DDL_INVALID_OPTION')
  return values.map((value) => quoteName(value, quote)).join(', ')
}

function referentialAction(capabilities: DdlCapabilities, value: string): string {
  const normalized = value.toLowerCase().replaceAll('_', ' ')
  const allowed = new Map([
    ['cascade', 'CASCADE'],
    ['restrict', 'RESTRICT'],
    ['no action', 'NO ACTION'],
    ['set null', 'SET NULL'],
    ['set default', 'SET DEFAULT'],
  ])
  const action = allowed.get(normalized)
  if (!action) throw new DdlValidationError('DDL_INVALID_OPTION')
  if (capabilities.engine === 'mysql' && action === 'SET DEFAULT') {
    throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  }
  return action
}

function constraintCapabilityKey(kind: DdlConstraint['kind']): keyof DdlCapabilities['constraint'] {
  if (kind === 'primary-key') return 'primaryKey'
  if (kind === 'foreign-key') return 'foreignKey'
  return kind
}

function renderMysqlDropConstraint(
  kind: DdlConstraint['kind'],
  name: string,
  quote: (value: string) => string,
): string {
  if (kind === 'primary-key') return 'DROP PRIMARY KEY'
  const quotedName = quoteName(name, quote)
  if (kind === 'foreign-key') return `DROP FOREIGN KEY ${quotedName}`
  if (kind === 'unique') return `DROP INDEX ${quotedName}`
  return `DROP CHECK ${quotedName}`
}

function safeFragment(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2_000 || /;|--|\/\*|\*\/|\0/.test(trimmed)) {
    throw new DdlValidationError('DDL_INVALID_FRAGMENT')
  }
  if (!/^[A-Za-z0-9_\s().'",:+*/%<>=!\-[\]]+$/.test(trimmed)) {
    throw new DdlValidationError('DDL_INVALID_FRAGMENT')
  }
  return trimmed
}

function renderColumn(
  capabilities: DdlCapabilities,
  column: DdlColumnDefinition,
  quote: (value: string) => string,
): string {
  const name = quoteName(column.name, quote)
  const type = renderType(capabilities, column.type)
  if (column.identity && !capabilities.column.identity) {
    throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  }
  const identity = column.identity
    ? capabilities.engine === 'postgres' ? ' GENERATED BY DEFAULT AS IDENTITY' : ' AUTO_INCREMENT'
    : ''
  const defaultValue = column.default ? ` DEFAULT ${renderDefault(column.default)}` : ''
  return `${name} ${type}${identity}${defaultValue}${column.nullable ? ' NULL' : ' NOT NULL'}`
}

function renderType(capabilities: DdlCapabilities, input: DdlColumnType): string {
  const name = input.name.toLowerCase()
  if (!capabilities.columnTypes.includes(name)) throw new DdlValidationError('DDL_TYPE_UNSUPPORTED')

  if (['varchar', 'char', 'binary', 'varbinary'].includes(name)) {
    if (!validInteger(input.length, 1, 65_535)) throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
    rejectUnusedTypeArguments(input, ['length'])
    return `${name}(${input.length})`
  }
  if (name === 'numeric' || name === 'decimal') {
    if (input.precision === undefined) {
      rejectUnusedTypeArguments(input, [])
      return name
    }
    if (!validInteger(input.precision, 1, 1_000)) throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
    if (input.scale !== undefined && !validInteger(input.scale, 0, input.precision)) {
      throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
    }
    rejectUnusedTypeArguments(input, ['precision', 'scale'])
    return input.scale === undefined ? `${name}(${input.precision})` : `${name}(${input.precision},${input.scale})`
  }
  if (name === 'enum') {
    if (capabilities.engine !== 'mysql' || !input.enumValues?.length) {
      throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
    }
    rejectUnusedTypeArguments(input, ['enumValues'])
    return `enum(${input.enumValues.map(quoteString).join(',')})`
  }
  rejectUnusedTypeArguments(input, [])
  return name
}

function rejectUnusedTypeArguments(input: DdlColumnType, allowed: Array<keyof DdlColumnType>): void {
  const supplied = (['length', 'precision', 'scale', 'enumValues'] as const)
    .filter((key) => input[key] !== undefined)
  if (supplied.some((key) => !allowed.includes(key))) {
    throw new DdlValidationError('DDL_INVALID_TYPE_ARGUMENT')
  }
}

function renderDefault(value: DdlDefault): string {
  if (value.kind === 'null') return 'NULL'
  if (value.kind === 'function') {
    const expression = DEFAULT_FUNCTIONS.get(value.name.toLowerCase())
    if (!expression) throw new DdlValidationError('DDL_INVALID_DEFAULT')
    return expression
  }
  if (typeof value.value === 'string') return quoteString(value.value)
  if (typeof value.value === 'boolean') return value.value ? 'TRUE' : 'FALSE'
  if (!Number.isFinite(value.value)) throw new DdlValidationError('DDL_INVALID_DEFAULT')
  return String(value.value)
}

function renderMysqlTableOptions(engine?: string, charset?: string, collation?: string): string {
  let result = ''
  if (engine) {
    const normalized = engine.toLowerCase()
    if (!MYSQL_ENGINES.has(normalized)) throw new DdlValidationError('DDL_INVALID_OPTION')
    result += ` ENGINE=${engine}`
  }
  if (charset) result += ` DEFAULT CHARACTER SET=${safeToken(charset)}`
  if (collation) result += ` COLLATE=${safeToken(collation)}`
  return result
}

function requireNoStorageOptions(engine?: string, charset?: string, collation?: string): '' {
  if (engine || charset || collation) throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  return ''
}

function quoteName(value: string, quote: (value: string) => string): string {
  if (!value || value.includes('\0') || value.length > 63) {
    throw new DdlValidationError('DDL_INVALID_IDENTIFIER')
  }
  return quote(value)
}

function quotePostgres(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteMysql(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function quoteLiteralToken(value: string): string {
  return quoteString(safeToken(value))
}

function safeToken(value: string): string {
  if (!SAFE_TOKEN.test(value)) throw new DdlValidationError('DDL_INVALID_OPTION')
  return value
}

function validInteger(value: number | undefined, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && value !== undefined && value >= minimum && value <= maximum
}

function requireCapability(supported: boolean): void {
  if (!supported) throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
}

function requireConfirmation(confirmed: boolean): void {
  if (!confirmed) throw new DdlValidationError('DDL_CONFIRMATION_REQUIRED')
}
