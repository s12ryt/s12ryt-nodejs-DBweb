import type { DatabaseEngine } from '../connections/connection-types.js'
import {
  normalizeNativeAccountIdentity,
  type NativeAccountIdentity,
} from './native-account-policy.js'

export type NativePrivilege =
  | 'connect'
  | 'usage'
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'create'
  | 'alter'
  | 'drop'
  | 'index'
  | 'references'

export type NativeGrantChange =
  | { scope: 'database'; database: string; privileges: NativePrivilege[] }
  | { scope: 'schema'; database: string; schema: string; privileges: NativePrivilege[] }
  | {
    scope: 'table'
    database: string
    schema?: string
    table: string
    privileges: NativePrivilege[]
  }

export interface NativeGrantCommand {
  kind: 'grant' | 'revoke'
  identity: NativeAccountIdentity
  changes: NativeGrantChange[]
  confirmed?: boolean
}

export interface NativeGrantPlan {
  transactional: boolean
  targetDatabase: string
  statements: string[]
}

export type NativeGrantValidationErrorCode =
  | 'INVALID_NATIVE_GRANT'
  | 'NATIVE_GRANT_CONFIRMATION_REQUIRED'
  | 'SYSTEM_DATABASE_PROTECTED'
  | 'UNSUPPORTED_NATIVE_PRIVILEGE'

export class NativeGrantValidationError extends Error {
  constructor(readonly code: NativeGrantValidationErrorCode) {
    super(code)
    this.name = 'NativeGrantValidationError'
  }
}

const POSTGRES_PRIVILEGES: Record<NativeGrantChange['scope'], ReadonlySet<NativePrivilege>> = {
  database: new Set(['connect', 'create']),
  schema: new Set(['usage', 'create']),
  table: new Set(['select', 'insert', 'update', 'delete', 'references']),
}

const MYSQL_PRIVILEGES: Record<NativeGrantChange['scope'], ReadonlySet<NativePrivilege>> = {
  database: new Set(['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'index', 'references']),
  schema: new Set(),
  table: new Set(['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'index', 'references']),
}

const PROTECTED_DATABASES: Record<DatabaseEngine, ReadonlySet<string>> = {
  postgres: new Set(['template0', 'template1']),
  mysql: new Set(['mysql', 'information_schema', 'performance_schema', 'sys']),
}

export function buildNativeGrantPlan(
  engine: DatabaseEngine,
  command: NativeGrantCommand,
): NativeGrantPlan {
  if (command.identity.engine !== engine || command.changes.length === 0 || command.changes.length > 100) {
    throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
  }
  if (command.kind === 'revoke' && !command.confirmed) {
    throw new NativeGrantValidationError('NATIVE_GRANT_CONFIRMATION_REQUIRED')
  }

  const identity = normalizeNativeAccountIdentity(engine, command.identity)
  const targetDatabase = command.changes[0]!.database
  validateNativeGrantTarget(engine, targetDatabase)
  if (command.changes.some((change) => change.database !== targetDatabase)) {
    throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
  }

  return {
    transactional: engine === 'postgres',
    targetDatabase,
    statements: command.changes.map((change) => buildStatement(engine, command.kind, identity, change)),
  }
}

export function validateNativeGrantTarget(engine: DatabaseEngine, targetDatabase: string): void {
  validateIdentifier(targetDatabase, engine)
  if (PROTECTED_DATABASES[engine].has(targetDatabase.toLowerCase())) {
    throw new NativeGrantValidationError('SYSTEM_DATABASE_PROTECTED')
  }
}

function buildStatement(
  engine: DatabaseEngine,
  kind: NativeGrantCommand['kind'],
  identity: NativeAccountIdentity,
  change: NativeGrantChange,
): string {
  validateChange(engine, change)
  const action = kind === 'grant' ? 'GRANT' : 'REVOKE'
  const recipient = kind === 'grant' ? 'TO' : 'FROM'
  const privileges = change.privileges.map((privilege) => privilege.toUpperCase()).join(', ')

  if (engine === 'postgres') {
    if (identity.engine !== 'postgres') throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
    const target = change.scope === 'database'
      ? `DATABASE ${quotePostgresIdentifier(change.database)}`
      : change.scope === 'schema'
        ? `SCHEMA ${quotePostgresIdentifier(change.schema)}`
        : `TABLE ${quotePostgresIdentifier(change.schema!)}.${quotePostgresIdentifier(change.table)}`
    return `${action} ${privileges} ON ${target} ${recipient} ${quotePostgresIdentifier(identity.username)}`
  }

  if (identity.engine !== 'mysql') throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
  if (change.scope === 'schema') throw new NativeGrantValidationError('UNSUPPORTED_NATIVE_PRIVILEGE')
  const target = change.scope === 'database'
    ? `${quoteMysqlDatabasePattern(change.database)}.*`
    : `${quoteMysqlIdentifier(change.database)}.${quoteMysqlIdentifier(change.table)}`
  return `${action} ${privileges} ON ${target} ${recipient} ${quoteMysqlLiteral(identity.username)}@${quoteMysqlLiteral(identity.host)}`
}

function validateChange(engine: DatabaseEngine, change: NativeGrantChange): void {
  validateIdentifier(change.database, engine)
  if (PROTECTED_DATABASES[engine].has(change.database.toLowerCase())) {
    throw new NativeGrantValidationError('SYSTEM_DATABASE_PROTECTED')
  }
  if (change.scope === 'schema') {
    if (engine !== 'postgres') throw new NativeGrantValidationError('UNSUPPORTED_NATIVE_PRIVILEGE')
    validateIdentifier(change.schema, engine)
  }
  if (change.scope === 'table') {
    validateIdentifier(change.table, engine)
    if (engine === 'postgres') {
      if (!change.schema) throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
      validateIdentifier(change.schema, engine)
    } else if (change.schema !== undefined) {
      throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
    }
  }

  const allowed = engine === 'postgres' ? POSTGRES_PRIVILEGES[change.scope] : MYSQL_PRIVILEGES[change.scope]
  if (
    change.privileges.length === 0 ||
    new Set(change.privileges).size !== change.privileges.length
  ) {
    throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
  }
  if (change.privileges.some((privilege) => !allowed.has(privilege))) {
    throw new NativeGrantValidationError('UNSUPPORTED_NATIVE_PRIVILEGE')
  }
}

function validateIdentifier(value: string, engine: DatabaseEngine): void {
  const maximumBytes = engine === 'postgres' ? 63 : 64
  if (
    value.trim().length === 0 ||
    new TextEncoder().encode(value).length > maximumBytes ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!
      return code === 0 || code < 32 || code === 127
    })
  ) {
    throw new NativeGrantValidationError('INVALID_NATIVE_GRANT')
  }
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}

function quoteMysqlDatabasePattern(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '``')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
  return `\`${escaped}\``
}

function quoteMysqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
