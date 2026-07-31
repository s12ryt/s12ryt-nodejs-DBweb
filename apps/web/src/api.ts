export type Locale = 'zh-TW' | 'en'
export type UserRole = 'admin' | 'user'

export interface User {
  id: string
  username: string
  role: UserRole
  enabled: boolean
  passwordChangeRequired: boolean
}

export type WebCapability = 'structure-read' | 'data-read' | 'query-read' | 'data-write' | 'ddl-write' | 'account-manage'

export interface WebAccessAssignment {
  userId: string
  connectionId: string
  capabilities: WebCapability[]
}

export interface Session {
  user: User
  csrfToken: string
}

export interface ConnectionProfile {
  id: string
  name: string
  engine: 'postgres' | 'mysql'
  host: string
  port: number
  database: string
  username: string
  tls: { mode: string; hasCa: boolean; hasClientCertificate: boolean }
  keepAlive: { enabled: boolean; intervalMs: number }
  ssh?:
    | { enabled: false }
    | { enabled: true; host: string; port: number; username: string }
  createdBy: string
  createdAt: string
}

export type NativeAccountIdentity =
  | { engine: 'postgres'; username: string }
  | { engine: 'mysql'; username: string; host: string }

export interface NativeAccount {
  identity: NativeAccountIdentity
  canLogin: boolean
  passwordExpired: boolean
  connectionLimit: number
  systemAccount: boolean
  managed: boolean
  managedAccountId?: string
  protected: boolean
  protectionReason?: 'connection-account' | 'system-account'
  managedStatus?: 'active' | 'disabled' | 'credential-stale' | 'deleted'
  recoverUntil?: string
}

export interface NativeAccountResult {
  account: NativeAccount
  password?: string
}

export type NativePrivilege = 'connect' | 'usage' | 'select' | 'insert' | 'update' | 'delete' | 'create' | 'alter' | 'drop' | 'index' | 'references'

export type NativeGrantChange =
  | { scope: 'database'; database: string; privileges: NativePrivilege[] }
  | { scope: 'schema'; database: string; schema: string; privileges: NativePrivilege[] }
  | { scope: 'table'; database: string; schema?: string; table: string; privileges: NativePrivilege[] }

export interface DatabaseTable {
  schema: string
  name: string
  type: 'table' | 'view'
}

export interface DatabaseColumn {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  defaultValue?: string
}

export interface RowPage {
  columns: string[]
  rows: Array<Record<string, unknown>>
  nextOffset: number | null
}

export type DatabaseValueType = 'array' | 'bigint' | 'binary' | 'boolean' | 'date' | 'datetime' | 'decimal' | 'enum' | 'json' | 'number' | 'string' | 'time' | 'timestamptz' | 'uuid'
export type TaggedDatabaseValue =
  | { kind: 'null' }
  | { kind: 'default' }
  | { kind: 'value'; type: DatabaseValueType; value: unknown }

export interface MutationColumn {
  name: string
  valueType: DatabaseValueType | 'unsupported'
  nullable: boolean
  generated: boolean
}

export interface DataMutationInspection {
  table: {
    schema: string
    name: string
    columns: MutationColumn[]
    uniqueKeys: Array<{ name: string; kind: 'primary' | 'unique'; columns: string[] }>
  }
  policy: {
    identity: { name: string; kind: 'primary' | 'unique'; columns: string[] } | null
    writableColumns: string[]
    readOnlyColumns: string[]
    canUpdate: boolean
    canDelete: boolean
  }
}

export interface DdlCapabilities {
  engine: 'postgres' | 'mysql'
  version: { major: number; minor: number; patch: number; assumedMinimum: boolean }
  transactionalDdl: boolean
  columnTypes: string[]
  database: { create: boolean; drop: boolean; rename: boolean; owner: boolean }
  schema: { create: boolean; drop: boolean; rename: boolean; owner: boolean; databaseAlias: boolean }
  table: { create: boolean; drop: boolean; rename: boolean; owner: boolean; storageOptions: boolean }
  column: { generated: boolean; identity: boolean; rename: boolean; renameSyntax: 'rename-column' | 'change-column' }
  constraint: { check: boolean; foreignKey: boolean; primaryKey: boolean; unique: boolean }
  index: { methods: string[]; expression: boolean; partial: boolean; prefixLength: boolean }
  advanced: {
    view: boolean
    materializedView: boolean
    sequence: boolean
    enum: boolean
    domain: boolean
    function: boolean
    procedure: boolean
    trigger: boolean
    partition: boolean
    extension: boolean
    event: boolean
  }
}

export interface QueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  affectedRows: number
  truncated: boolean
  durationMs: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    body?: unknown
    csrfToken?: string
    locale: Locale
    signal?: AbortSignal
  },
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      'accept-language': options.locale,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.csrfToken ? { 'x-csrf-token': options.csrfToken } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}
