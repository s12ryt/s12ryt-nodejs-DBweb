import type { DatabaseEngine } from '../connections/connection-types.js'
import type { DdlCommand } from '../ddl/ddl-command.js'

export type SqlDumpObjectKind =
  | 'schema'
  | 'type'
  | 'domain'
  | 'sequence'
  | 'table'
  | 'index'
  | 'constraint'
  | 'view'
  | 'materialized-view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'partition'
  | 'extension'
  | 'event'

export type SqlDumpScope =
  | { kind: 'table'; schema: string; table: string }
  | { kind: 'schema'; schema: string }
  | { kind: 'database' }

export interface SqlDumpObject {
  id: string
  kind: SqlDumpObjectKind
  schema?: string
  name: string
  dependencies: string[]
  createCommands: DdlCommand[]
  dropCommand: DdlCommand
  dataEntry?: string
}

export interface SqlDumpEntry {
  path: string
  size: number
  sha256: string
  objectId: string
  kind: 'data' | 'definition'
}

export interface SqlDumpManifest {
  format: 'dbweb-sql-dump'
  version: 1
  engine: DatabaseEngine
  serverVersion: string
  database: string
  scope: SqlDumpScope
  objects: SqlDumpObject[]
  entries: SqlDumpEntry[]
}

export class SqlDumpManifestError extends Error {
  constructor(readonly code: 'INVALID_SQL_DUMP_MANIFEST') {
    super(code)
    this.name = 'SqlDumpManifestError'
  }
}

const OBJECT_KINDS = new Set<SqlDumpObjectKind>([
  'schema',
  'type',
  'domain',
  'sequence',
  'table',
  'index',
  'constraint',
  'view',
  'materialized-view',
  'function',
  'procedure',
  'trigger',
  'partition',
  'extension',
  'event',
])

export function validateSqlDumpManifest(value: unknown, expectedEngine: DatabaseEngine): SqlDumpManifest {
  if (
    !isRecord(value)
    || !onlyKeys(value, ['format', 'version', 'engine', 'serverVersion', 'database', 'scope', 'objects', 'entries'])
    || value.format !== 'dbweb-sql-dump'
    || value.version !== 1
    || value.engine !== expectedEngine
    || !nonEmpty(value.serverVersion)
    || !nonEmpty(value.database)
    || !Array.isArray(value.objects)
    || value.objects.length === 0
    || value.objects.length > 10_000
    || !Array.isArray(value.entries)
    || value.entries.length > 10_000
  ) invalidManifest()
  validateScope(value.scope)

  const objectIds = new Set<string>()
  const objects = value.objects as unknown[]
  for (const candidate of objects) {
    if (!isRecord(candidate) || !validateObjectShape(candidate) || objectIds.has(candidate.id as string)) {
      invalidManifest()
    }
    objectIds.add(candidate.id as string)
  }
  for (const candidate of objects) {
    const object = candidate as unknown as SqlDumpObject
    if (object.dependencies.some((dependency) => dependency === object.id || !objectIds.has(dependency))) {
      invalidManifest()
    }
  }

  const entryPaths = new Set<string>()
  const dataEntries = new Map<string, string>()
  for (const candidate of value.entries as unknown[]) {
    if (!isRecord(candidate) || !validateEntryShape(candidate, objectIds) || entryPaths.has(candidate.path as string)) {
      invalidManifest()
    }
    entryPaths.add(candidate.path as string)
    if (candidate.kind === 'data') {
      if (dataEntries.has(candidate.objectId as string)) invalidManifest()
      dataEntries.set(candidate.objectId as string, candidate.path as string)
    }
  }
  for (const candidate of objects) {
    const object = candidate as unknown as SqlDumpObject
    if (object.dataEntry !== undefined && dataEntries.get(object.id) !== object.dataEntry) invalidManifest()
    if (object.dataEntry === undefined && dataEntries.has(object.id)) invalidManifest()
  }

  return value as unknown as SqlDumpManifest
}

function validateObjectShape(value: Record<string, unknown>): boolean {
  if (!onlyKeys(value, ['id', 'kind', 'schema', 'name', 'dependencies', 'createCommands', 'dropCommand', 'dataEntry'])) {
    return false
  }
  return nonEmpty(value.id)
    && typeof value.kind === 'string'
    && OBJECT_KINDS.has(value.kind as SqlDumpObjectKind)
    && (value.schema === undefined || nonEmpty(value.schema))
    && nonEmpty(value.name)
    && Array.isArray(value.dependencies)
    && value.dependencies.length <= 10_000
    && value.dependencies.every(nonEmpty)
    && new Set(value.dependencies).size === value.dependencies.length
    && Array.isArray(value.createCommands)
    && value.createCommands.length > 0
    && value.createCommands.every(isDdlCommandShape)
    && isDdlCommandShape(value.dropCommand)
    && (value.dataEntry === undefined || safeEntryPath(value.dataEntry))
}

function validateEntryShape(value: Record<string, unknown>, objectIds: ReadonlySet<string>): boolean {
  return onlyKeys(value, ['path', 'size', 'sha256', 'objectId', 'kind'])
    && safeEntryPath(value.path)
    && typeof value.size === 'number'
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256)
    && typeof value.objectId === 'string'
    && objectIds.has(value.objectId)
    && (value.kind === 'data' || value.kind === 'definition')
}

function validateScope(value: unknown): void {
  if (!isRecord(value) || typeof value.kind !== 'string') invalidManifest()
  if (value.kind === 'database' && onlyKeys(value, ['kind'])) return
  if (value.kind === 'schema' && onlyKeys(value, ['kind', 'schema']) && nonEmpty(value.schema)) return
  if (
    value.kind === 'table'
    && onlyKeys(value, ['kind', 'schema', 'table'])
    && nonEmpty(value.schema)
    && nonEmpty(value.table)
  ) return
  invalidManifest()
}

function isDdlCommandShape(value: unknown): boolean {
  return isRecord(value) && nonEmpty(value.kind)
}

function safeEntryPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function invalidManifest(): never {
  throw new SqlDumpManifestError('INVALID_SQL_DUMP_MANIFEST')
}
