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
const SAFE_VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
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
      const primaryKey = renderCreateTablePrimaryKey(capabilities, command.columns, command.primaryKey, quote)
      if (primaryKey) columns.push(primaryKey)
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
    case 'create-view':
      requireAdvancedCapability(capabilities, 'view')
      requireConfirmation(command.confirmed)
      return [`CREATE${command.replace ? ' OR REPLACE' : ''} VIEW ${qualified(command.schema, command.name)} AS ${rawDefinition(command.query)}`]
    case 'drop-view':
      requireAdvancedCapability(capabilities, 'view')
      requireConfirmation(command.confirmed)
      if (capabilities.engine === 'mysql' && command.cascade) {
        throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
      }
      return [`DROP VIEW ${qualified(command.schema, command.name)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-materialized-view':
      requireAdvancedCapability(capabilities, 'materializedView')
      requireConfirmation(command.confirmed)
      return [`CREATE MATERIALIZED VIEW ${qualified(command.schema, command.name)} AS ${rawDefinition(command.query)}${command.withData ? '' : ' WITH NO DATA'}`]
    case 'refresh-materialized-view':
      requireAdvancedCapability(capabilities, 'materializedView')
      requireConfirmation(command.confirmed)
      return [`REFRESH MATERIALIZED VIEW${command.concurrently ? ' CONCURRENTLY' : ''} ${qualified(command.schema, command.name)}`]
    case 'drop-materialized-view':
      requireAdvancedCapability(capabilities, 'materializedView')
      requireConfirmation(command.confirmed)
      return [`DROP MATERIALIZED VIEW ${qualified(command.schema, command.name)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-sequence':
      requireAdvancedCapability(capabilities, 'sequence')
      return [renderCreateSequence(command, qualified)]
    case 'drop-sequence':
      requireAdvancedCapability(capabilities, 'sequence')
      requireConfirmation(command.confirmed)
      return [`DROP SEQUENCE ${qualified(command.schema, command.name)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-enum':
      requireAdvancedCapability(capabilities, 'enum')
      if (command.values.length === 0 || new Set(command.values).size !== command.values.length) {
        throw new DdlValidationError('DDL_INVALID_OPTION')
      }
      return [`CREATE TYPE ${qualified(command.schema, command.name)} AS ENUM (${command.values.map(validatedStringLiteral).join(', ')})`]
    case 'create-domain': {
      requireAdvancedCapability(capabilities, 'domain')
      if (command.check) requireConfirmation(command.confirmed)
      const defaultValue = command.default ? ` DEFAULT ${renderDefault(capabilities, command.default, quote)}` : ''
      const nullable = command.nullable ? '' : ' NOT NULL'
      const check = command.check ? ` CHECK (${safeFragment(command.check)})` : ''
      return [`CREATE DOMAIN ${qualified(command.schema, command.name)} AS ${renderType(capabilities, command.baseType)}${defaultValue}${nullable}${check}`]
    }
    case 'drop-type':
      requireCapability(capabilities.advanced.enum || capabilities.advanced.domain)
      requireConfirmation(command.confirmed)
      return [`DROP TYPE ${qualified(command.schema, command.name)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-extension': {
      requireAdvancedCapability(capabilities, 'extension')
      requireConfirmation(command.confirmed)
      const schema = command.schema ? ` SCHEMA ${quoteName(command.schema, quote)}` : ''
      const version = command.version ? ` VERSION ${quoteVersion(command.version)}` : ''
      return [`CREATE EXTENSION ${quoteName(command.name, quote)}${schema}${version}${command.cascade ? ' CASCADE' : ''}`]
    }
    case 'drop-extension':
      requireAdvancedCapability(capabilities, 'extension')
      requireConfirmation(command.confirmed)
      return [`DROP EXTENSION ${quoteName(command.name, quote)}${command.cascade ? ' CASCADE' : ''}`]
    case 'create-routine':
      requireAdvancedCapability(capabilities, command.routineKind)
      requireConfirmation(command.confirmed)
      return [renderCreateRoutine(capabilities, command, quote, qualified)]
    case 'drop-routine':
      requireAdvancedCapability(capabilities, command.routineKind)
      requireConfirmation(command.confirmed)
      return [renderDropRoutine(capabilities, command, qualified)]
    case 'create-trigger':
      requireAdvancedCapability(capabilities, 'trigger')
      requireConfirmation(command.confirmed)
      return [renderCreateTrigger(capabilities, command, quote, qualified)]
    case 'drop-trigger':
      requireAdvancedCapability(capabilities, 'trigger')
      requireConfirmation(command.confirmed)
      return [capabilities.engine === 'postgres'
        ? `DROP TRIGGER ${quoteName(command.name, quote)} ON ${qualified(command.schema, command.table)}`
        : `DROP TRIGGER ${qualified(command.schema, command.name)}`]
    case 'create-event':
      requireAdvancedCapability(capabilities, 'event')
      requireConfirmation(command.confirmed)
      return [renderCreateEvent(command, qualified)]
    case 'drop-event':
      requireAdvancedCapability(capabilities, 'event')
      requireConfirmation(command.confirmed)
      return [`DROP EVENT ${qualified(command.schema, command.name)}`]
    case 'create-partition':
      requireAdvancedCapability(capabilities, 'partition')
      requireConfirmation(command.confirmed)
      return [capabilities.engine === 'postgres'
        ? `CREATE TABLE ${qualified(command.schema, command.name)} PARTITION OF ${qualified(command.schema, command.table)} ${safeFragment(command.definition)}`
        : `ALTER TABLE ${qualified(command.schema, command.table)} ADD PARTITION (PARTITION ${quoteName(command.name, quote)} ${safeFragment(command.definition)})`]
    case 'drop-partition':
      requireAdvancedCapability(capabilities, 'partition')
      requireConfirmation(command.confirmed)
      return [capabilities.engine === 'postgres'
        ? `DROP TABLE ${qualified(command.schema, command.name)}`
        : `ALTER TABLE ${qualified(command.schema, command.table)} DROP PARTITION ${quoteName(command.name, quote)}`]
  }
}

function renderCreateRoutine(
  capabilities: DdlCapabilities,
  command: Extract<DdlCommand, { kind: 'create-routine' }>,
  quote: (value: string) => string,
  qualified: (schema: string, name: string) => string,
): string {
  const routine = command.routineKind.toUpperCase()
  const argumentsSql = command.arguments
    .map((argument) => renderRoutineArgument(capabilities, argument, quote))
    .join(', ')
  const body = rawDefinition(command.body)
  if (capabilities.engine === 'postgres') {
    if (command.deterministic !== undefined || command.dataAccess !== undefined) {
      throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
    }
    const language = command.language?.toLowerCase()
    if (!language || !['sql', 'plpgsql'].includes(language)) {
      throw new DdlValidationError('DDL_INVALID_OPTION')
    }
    if (command.routineKind === 'function' && !command.returns) {
      throw new DdlValidationError('DDL_INVALID_OPTION')
    }
    if (command.routineKind === 'procedure' && (command.returns || command.returnsSet || command.volatility || command.strict)) {
      throw new DdlValidationError('DDL_INVALID_OPTION')
    }
    const returns = command.returns
      ? ` RETURNS ${command.returnsSet ? 'SETOF ' : ''}${renderType(capabilities, command.returns)}`
      : ''
    const volatility = command.volatility ? ` ${command.volatility.toUpperCase()}` : ''
    const security = command.security ? ` SECURITY ${command.security.toUpperCase()}` : ''
    const strict = command.strict ? ' STRICT' : ''
    const delimiter = dollarQuoteFor(body)
    return `CREATE${command.replace ? ' OR REPLACE' : ''} ${routine} ${qualified(command.schema, command.name)}(${argumentsSql})${returns} LANGUAGE ${language}${volatility}${security}${strict} AS ${delimiter}${body}${delimiter}`
  }

  if (command.replace || command.language || command.volatility || command.strict || command.returnsSet) {
    throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
  }
  if (command.routineKind === 'function' && !command.returns) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  if (command.routineKind === 'function'
    && command.deterministic !== true
    && command.dataAccess !== 'no-sql'
    && command.dataAccess !== 'reads-sql-data') {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  if (command.routineKind === 'procedure' && command.returns) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  const returns = command.returns ? ` RETURNS ${renderType(capabilities, command.returns)}` : ''
  const security = command.security ? ` SQL SECURITY ${command.security.toUpperCase()}` : ''
  const deterministic = command.deterministic === undefined
    ? ''
    : command.deterministic ? ' DETERMINISTIC' : ' NOT DETERMINISTIC'
  const dataAccess = command.dataAccess ? ` ${mysqlDataAccess(command.dataAccess)}` : ''
  return `CREATE ${routine} ${qualified(command.schema, command.name)}(${argumentsSql})${returns}${deterministic}${dataAccess}${security} ${body}`
}

function mysqlDataAccess(value: NonNullable<Extract<DdlCommand, { kind: 'create-routine' }>['dataAccess']>): string {
  const values = {
    'no-sql': 'NO SQL',
    'contains-sql': 'CONTAINS SQL',
    'reads-sql-data': 'READS SQL DATA',
    'modifies-sql-data': 'MODIFIES SQL DATA',
  } as const
  return values[value]
}

function renderDropRoutine(
  capabilities: DdlCapabilities,
  command: Extract<DdlCommand, { kind: 'drop-routine' }>,
  qualified: (schema: string, name: string) => string,
): string {
  const routine = command.routineKind.toUpperCase()
  if (capabilities.engine === 'mysql') {
    if (command.argumentTypes.length > 0 || command.cascade) {
      throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
    }
    return `DROP ${routine} ${qualified(command.schema, command.name)}`
  }
  const signature = command.argumentTypes.map((type) => renderType(capabilities, type)).join(', ')
  return `DROP ${routine} ${qualified(command.schema, command.name)}(${signature})${command.cascade ? ' CASCADE' : ''}`
}

function renderRoutineArgument(
  capabilities: DdlCapabilities,
  argument: import('./ddl-command.js').DdlRoutineArgument,
  quote: (value: string) => string,
): string {
  const mode = argument.mode ? `${argument.mode.toUpperCase()} ` : ''
  const name = argument.name ? `${quoteName(argument.name, quote)} ` : ''
  return `${mode}${name}${renderType(capabilities, argument.type)}`
}

function renderCreateTrigger(
  capabilities: DdlCapabilities,
  command: Extract<DdlCommand, { kind: 'create-trigger' }>,
  quote: (value: string) => string,
  qualified: (schema: string, name: string) => string,
): string {
  if (command.events.length === 0 || new Set(command.events).size !== command.events.length) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  const timing = command.timing.replace('-', ' ').toUpperCase()
  const events = command.events.map((event) => event.toUpperCase()).join(' OR ')
  if (capabilities.engine === 'mysql') {
    if (command.events.length !== 1 || command.events[0] === 'truncate'
      || command.timing === 'instead-of' || command.forEach !== 'row'
      || !command.body || command.functionName || command.functionSchema || command.when) {
      throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
    }
    return `CREATE TRIGGER ${qualified(command.schema, command.name)} ${timing} ${events} ON ${qualified(command.schema, command.table)} FOR EACH ROW ${rawDefinition(command.body)}`
  }
  if (!command.functionName || !command.functionSchema || command.body) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  const when = command.when ? ` WHEN (${safeFragment(command.when)})` : ''
  const functionArguments = (command.functionArguments ?? []).map(validatedStringLiteral).join(', ')
  const executeKeyword = capabilities.version.major >= 11 ? 'FUNCTION' : 'PROCEDURE'
  return `CREATE TRIGGER ${quoteName(command.name, quote)} ${timing} ${events} ON ${qualified(command.schema, command.table)} FOR EACH ${command.forEach.toUpperCase()}${when} EXECUTE ${executeKeyword} ${qualified(command.functionSchema, command.functionName)}(${functionArguments})`
}

function renderCreateEvent(
  command: Extract<DdlCommand, { kind: 'create-event' }>,
  qualified: (schema: string, name: string) => string,
): string {
  const schedule = command.schedule.kind === 'at'
    ? `AT ${validatedStringLiteral(command.schedule.at)}`
    : `EVERY ${positiveInteger(command.schedule.amount)} ${command.schedule.unit.toUpperCase()}`
  return `CREATE EVENT ${qualified(command.schema, command.name)} ON SCHEDULE ${schedule} ON COMPLETION ${command.preserve ? 'PRESERVE' : 'NOT PRESERVE'} ${command.enabled ? 'ENABLE' : 'DISABLE'} DO ${rawDefinition(command.body)}`
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new DdlValidationError('DDL_INVALID_OPTION')
  return value
}

function dollarQuoteFor(body: string): string {
  let index = 0
  while (true) {
    const delimiter = index === 0 ? '$dbweb$' : `$dbweb${index}$`
    if (!body.includes(delimiter)) return delimiter
    index += 1
  }
}

function renderCreateSequence(
  command: Extract<DdlCommand, { kind: 'create-sequence' }>,
  qualified: (schema: string, name: string) => string,
): string {
  const parts = [`CREATE SEQUENCE ${qualified(command.schema, command.name)}`]
  if (command.increment !== undefined) parts.push(`INCREMENT BY ${sequenceInteger(command.increment, 'nonzero')}`)
  if (command.minValue !== undefined) parts.push(`MINVALUE ${sequenceInteger(command.minValue, 'any')}`)
  if (command.maxValue !== undefined) parts.push(`MAXVALUE ${sequenceInteger(command.maxValue, 'any')}`)
  if (command.start !== undefined) parts.push(`START WITH ${sequenceInteger(command.start, 'any')}`)
  if (command.cache !== undefined) parts.push(`CACHE ${sequenceInteger(command.cache, 'positive')}`)
  if (command.cycle) parts.push('CYCLE')
  if (command.minValue !== undefined && command.maxValue !== undefined && command.minValue >= command.maxValue) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  return parts.join(' ')
}

function sequenceInteger(value: number, rule: 'any' | 'nonzero' | 'positive'): number {
  if (!Number.isSafeInteger(value)
    || rule === 'nonzero' && value === 0
    || rule === 'positive' && value < 1) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  return value
}

function rawDefinition(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 1_000_000 || trimmed.includes('\0')) {
    throw new DdlValidationError('DDL_INVALID_FRAGMENT')
  }
  return trimmed
}

function validatedStringLiteral(value: string): string {
  if (!value || value.length > 10_000 || value.includes('\0')) {
    throw new DdlValidationError('DDL_INVALID_OPTION')
  }
  return quoteString(value)
}

function quoteVersion(value: string): string {
  if (!SAFE_VERSION_TOKEN.test(value)) throw new DdlValidationError('DDL_INVALID_OPTION')
  return quoteString(value)
}

function requireAdvancedCapability(
  capabilities: DdlCapabilities,
  key: keyof DdlCapabilities['advanced'],
): void {
  requireCapability(capabilities.advanced[key])
}

function renderCreateTablePrimaryKey(
  capabilities: DdlCapabilities,
  columns: DdlColumnDefinition[],
  primaryKey: string[] | undefined,
  quote: (value: string) => string,
): string | undefined {
  const columnNames = new Set(columns.map((column) => column.name))
  if (primaryKey !== undefined) {
    if (primaryKey.length === 0 || new Set(primaryKey).size !== primaryKey.length || primaryKey.some((name) => !columnNames.has(name))) {
      throw new DdlValidationError('DDL_INVALID_OPTION')
    }
  }
  if (capabilities.engine === 'mysql') {
    const identityColumns = columns.filter((column) => column.identity).map((column) => column.name)
    if (identityColumns.some((name) => !primaryKey?.includes(name))) {
      throw new DdlValidationError('DDL_INVALID_OPTION')
    }
  }
  return primaryKey ? `PRIMARY KEY (${primaryKey.map((name) => quoteName(name, quote)).join(', ')})` : undefined
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
  const defaultValue = column.default ? ` DEFAULT ${renderDefault(capabilities, column.default, quote)}` : ''
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

function renderDefault(
  capabilities: DdlCapabilities,
  value: DdlDefault,
  quote: (value: string) => string,
): string {
  if (value.kind === 'null') return 'NULL'
  if (value.kind === 'function') {
    const expression = DEFAULT_FUNCTIONS.get(value.name.toLowerCase())
    if (!expression) throw new DdlValidationError('DDL_INVALID_DEFAULT')
    return expression
  }
  if (value.kind === 'sequence') {
    if (capabilities.engine !== 'postgres') throw new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED')
    const sequence = `${quoteName(value.schema, quote)}.${quoteName(value.name, quote)}`
    return `nextval(${quoteString(sequence)}::regclass)`
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
