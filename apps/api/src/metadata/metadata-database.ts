import Database from 'better-sqlite3'
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type ColumnType,
  type Generated,
} from 'kysely'
import { Pool } from 'pg'

import type { DdlCommand } from '../ddl/ddl-command.js'
import type { DdlAuditEntry } from '../ddl/ddl-service.js'
import type { SecurityAuditAction } from '../security/security-audit.js'
import type { StoredNativeAccount } from '../accounts/native-account-service.js'

interface UsersTable {
  id: string
  username: string
  normalized_username: string
  password_hash: string
  role: 'admin' | 'user'
  enabled: Generated<number>
  password_change_required: Generated<number>
  created_at: string
}

interface AuthLifecycleLockTable {
  id: number
  revision: number
}

interface SessionsTable {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  last_seen_at: string
  absolute_expires_at: string
}

interface ConnectionsTable {
  id: string
  name: string
  engine: 'postgres' | 'mysql'
  host: string
  port: number
  database_name: string
  username: string
  tls_mode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
  tls_has_ca: number
  tls_has_client_certificate: number
  keepalive_enabled: number
  keepalive_interval_ms: number
  ssh_enabled: number
  ssh_host: string | null
  ssh_port: number | null
  ssh_username: string | null
  created_by: string
  created_at: string
  encrypted_secrets: string
}

interface WebAccessAssignmentsTable {
  user_id: string
  connection_id: string
  structure_read: number
  data_read: number
  query_read: number
  data_write: number
  ddl_write: number
  account_manage: number
}

interface QueryAuditsTable {
  id: string
  query_id: string
  user_id: string
  connection_id: string
  encrypted_sql: string
  status: 'success' | 'failed' | 'cancelled' | 'timeout'
  duration_ms: number
  row_count: number
  error_code: string | null
  created_at: string
  expires_at: string
}

interface KeepAliveEventsTable {
  id: string
  connection_id: string
  status: 'success' | 'failed' | 'timeout'
  duration_ms: number
  created_at: string
  expires_at: string
}

interface SshKnownHostsTable {
  endpoint: string
  fingerprint: string
  created_at: string
}

interface SshHostKeyResetsTable {
  id: string
  endpoint: string
  actor_id: string
  created_at: string
}

interface MutationAuditsTable {
  id: string
  actor_id: string
  connection_id: string
  object_type: 'table'
  object_name: string
  action: 'mutate-rows'
  operation_count: number
  affected_rows: number
  status: 'success' | 'failed'
  encrypted_sql_templates: string
  error_code: string | null
  created_at: string
  expires_at: string
}

interface DdlAuditsTable {
  id: string
  actor_id: string
  connection_id: string
  object_type: DdlAuditEntry['objectType']
  object_name: string
  action: DdlCommand['kind']
  statement_count: number
  transactional: number
  status: 'success' | 'failed'
  encrypted_sql_templates: string
  error_code: string | null
  created_at: string
  expires_at: string
}

interface SecurityAuditsTable {
  id: string
  actor_id: string
  target_user_id: string | null
  connection_id: string | null
  action: SecurityAuditAction
  status: 'success' | 'failed'
  encrypted_details: string
  error_code: string | null
  created_at: string
  expires_at: string
}

interface ManagedNativeAccountsTable {
  id: string
  connection_id: string
  identity_key: string
  engine: 'postgres' | 'mysql'
  username: string
  host: string | null
  encrypted_password: string
  verification_database: string
  verification_interval_ms: number
  can_login: number
  connection_limit: number
  status: StoredNativeAccount['status']
  verification_failures: number
  next_verification_at: string
  last_verified_at: string | null
  retry_verification_at: string | null
  deleted_at: string | null
  recover_until: string | null
  created_at: string
  updated_at: string
}

export interface MetadataDatabase {
  auth_lifecycle_lock: AuthLifecycleLockTable
  users: UsersTable
  sessions: SessionsTable
  connections: ConnectionsTable
  ddl_audits: DdlAuditsTable
  keepalive_events: KeepAliveEventsTable
  managed_native_accounts: ManagedNativeAccountsTable
  mutation_audits: MutationAuditsTable
  query_audits: QueryAuditsTable
  security_audits: SecurityAuditsTable
  ssh_host_key_resets: SshHostKeyResetsTable
  ssh_known_hosts: SshKnownHostsTable
  web_access_assignments: WebAccessAssignmentsTable
}

export type MetadataKysely = Kysely<MetadataDatabase>

export type MetadataDatabaseConfig =
  | { kind: 'sqlite'; filename: string }
  | { kind: 'postgres'; connectionString: string; maxConnections?: number }

export function createMetadataDatabase(config: MetadataDatabaseConfig): MetadataKysely {
  if (config.kind === 'sqlite') {
    const database = new Database(config.filename)
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    if (config.filename !== ':memory:') database.pragma('journal_mode = WAL')
    return new Kysely<MetadataDatabase>({
      dialect: new SqliteDialect({ database }),
    })
  }

  return new Kysely<MetadataDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: config.connectionString,
        max: config.maxConnections ?? 10,
      }),
    }),
  })
}

export async function migrateMetadata(database: MetadataKysely): Promise<void> {
  await database.schema
    .createTable('users')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('username', 'varchar(128)', (column) => column.notNull())
    .addColumn('normalized_username', 'varchar(128)', (column) => column.notNull().unique())
    .addColumn('password_hash', 'varchar(512)', (column) => column.notNull())
    .addColumn('role', 'varchar(16)', (column) => column.notNull())
    .addColumn('enabled', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('password_change_required', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  const usersTable = (await database.introspection.getTables()).find((table) => table.name === 'users')
  const userColumns = new Set(usersTable?.columns.map((column) => column.name))
  if (!userColumns.has('enabled')) {
    await database.schema
      .alterTable('users')
      .addColumn('enabled', 'integer', (column) => column.notNull().defaultTo(1))
      .execute()
  }
  if (!userColumns.has('password_change_required')) {
    await database.schema
      .alterTable('users')
      .addColumn('password_change_required', 'integer', (column) => column.notNull().defaultTo(0))
      .execute()
  }

  await database.schema
    .createTable('auth_lifecycle_lock')
    .ifNotExists()
    .addColumn('id', 'integer', (column) => column.primaryKey())
    .addColumn('revision', 'integer', (column) => column.notNull())
    .execute()
  await database
    .insertInto('auth_lifecycle_lock')
    .values({ id: 1, revision: 0 })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute()

  await database.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('user_id', 'varchar(36)', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'varchar(64)', (column) => column.notNull().unique())
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('last_seen_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('absolute_expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('connections')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('name', 'varchar(128)', (column) => column.notNull())
    .addColumn('engine', 'varchar(16)', (column) => column.notNull())
    .addColumn('host', 'varchar(255)', (column) => column.notNull())
    .addColumn('port', 'integer', (column) => column.notNull())
    .addColumn('database_name', 'varchar(128)', (column) => column.notNull())
    .addColumn('username', 'varchar(128)', (column) => column.notNull())
    .addColumn('tls_mode', 'varchar(16)', (column) => column.notNull())
    .addColumn('tls_has_ca', 'integer', (column) => column.notNull())
    .addColumn('tls_has_client_certificate', 'integer', (column) => column.notNull())
    .addColumn('keepalive_enabled', 'integer', (column) => column.notNull())
    .addColumn('keepalive_interval_ms', 'integer', (column) => column.notNull())
    .addColumn('ssh_enabled', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('ssh_host', 'varchar(255)')
    .addColumn('ssh_port', 'integer')
    .addColumn('ssh_username', 'varchar(128)')
    .addColumn('created_by', 'varchar(36)', (column) => column.notNull())
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('encrypted_secrets', 'text', (column) => column.notNull())
    .execute()

  const connectionTable = (await database.introspection.getTables())
    .find((table) => table.name === 'connections')
  const connectionColumns = new Set(connectionTable?.columns.map((column) => column.name))
  if (!connectionColumns.has('ssh_enabled')) {
    await database.schema
      .alterTable('connections')
      .addColumn('ssh_enabled', 'integer', (column) => column.notNull().defaultTo(0))
      .execute()
  }
  if (!connectionColumns.has('ssh_host')) {
    await database.schema.alterTable('connections').addColumn('ssh_host', 'varchar(255)').execute()
  }
  if (!connectionColumns.has('ssh_port')) {
    await database.schema.alterTable('connections').addColumn('ssh_port', 'integer').execute()
  }
  if (!connectionColumns.has('ssh_username')) {
    await database.schema
      .alterTable('connections')
      .addColumn('ssh_username', 'varchar(128)')
      .execute()
  }

  await database.schema
    .createTable('web_access_assignments')
    .ifNotExists()
    .addColumn('user_id', 'varchar(36)', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('connection_id', 'varchar(36)', (column) =>
      column.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('structure_read', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('data_read', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('query_read', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('data_write', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('ddl_write', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('account_manage', 'integer', (column) => column.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('web_access_assignments_primary_key', ['user_id', 'connection_id'])
    .execute()

  await database.schema
    .createTable('managed_native_accounts')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('connection_id', 'varchar(36)', (column) =>
      column.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('identity_key', 'varchar(512)', (column) => column.notNull())
    .addColumn('engine', 'varchar(16)', (column) => column.notNull())
    .addColumn('username', 'varchar(128)', (column) => column.notNull())
    .addColumn('host', 'varchar(255)')
    .addColumn('encrypted_password', 'text', (column) => column.notNull())
    .addColumn('verification_database', 'varchar(128)', (column) => column.notNull())
    .addColumn('verification_interval_ms', 'integer', (column) => column.notNull())
    .addColumn('can_login', 'integer', (column) => column.notNull())
    .addColumn('connection_limit', 'integer', (column) => column.notNull())
    .addColumn('status', 'varchar(32)', (column) => column.notNull())
    .addColumn('verification_failures', 'integer', (column) => column.notNull())
    .addColumn('next_verification_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('last_verified_at', 'varchar(35)')
    .addColumn('retry_verification_at', 'varchar(35)')
    .addColumn('deleted_at', 'varchar(35)')
    .addColumn('recover_until', 'varchar(35)')
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('updated_at', 'varchar(35)', (column) => column.notNull())
    .addUniqueConstraint('managed_native_accounts_identity_unique', [
      'connection_id',
      'identity_key',
    ])
    .execute()

  await database.schema
    .createTable('query_audits')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('query_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('user_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('connection_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('encrypted_sql', 'text', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('duration_ms', 'integer', (column) => column.notNull())
    .addColumn('row_count', 'integer', (column) => column.notNull())
    .addColumn('error_code', 'varchar(64)')
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('keepalive_events')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('connection_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('duration_ms', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('ssh_known_hosts')
    .ifNotExists()
    .addColumn('endpoint', 'varchar(320)', (column) => column.primaryKey())
    .addColumn('fingerprint', 'varchar(128)', (column) => column.notNull())
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('ssh_host_key_resets')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('endpoint', 'varchar(320)', (column) => column.notNull())
    .addColumn('actor_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('mutation_audits')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('actor_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('connection_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('object_type', 'varchar(32)', (column) => column.notNull())
    .addColumn('object_name', 'varchar(512)', (column) => column.notNull())
    .addColumn('action', 'varchar(64)', (column) => column.notNull())
    .addColumn('operation_count', 'integer', (column) => column.notNull())
    .addColumn('affected_rows', 'integer', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('encrypted_sql_templates', 'text', (column) => column.notNull())
    .addColumn('error_code', 'varchar(64)')
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('ddl_audits')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('actor_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('connection_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('object_type', 'varchar(32)', (column) => column.notNull())
    .addColumn('object_name', 'varchar(512)', (column) => column.notNull())
    .addColumn('action', 'varchar(64)', (column) => column.notNull())
    .addColumn('statement_count', 'integer', (column) => column.notNull())
    .addColumn('transactional', 'integer', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('encrypted_sql_templates', 'text', (column) => column.notNull())
    .addColumn('error_code', 'varchar(64)')
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createTable('security_audits')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('actor_id', 'varchar(36)', (column) => column.notNull())
    .addColumn('target_user_id', 'varchar(36)')
    .addColumn('connection_id', 'varchar(36)')
    .addColumn('action', 'varchar(64)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('encrypted_details', 'text', (column) => column.notNull())
    .addColumn('error_code', 'varchar(64)')
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
    .addColumn('expires_at', 'varchar(35)', (column) => column.notNull())
    .execute()

  await database.schema
    .createIndex('query_audits_expires_at_index')
    .ifNotExists()
    .on('query_audits')
    .column('expires_at')
    .execute()

  await database.schema
    .createIndex('mutation_audits_expires_at_index')
    .ifNotExists()
    .on('mutation_audits')
    .column('expires_at')
    .execute()

  await database.schema
    .createIndex('ddl_audits_expires_at_index')
    .ifNotExists()
    .on('ddl_audits')
    .column('expires_at')
    .execute()

  await database.schema
    .createIndex('keepalive_events_expires_at_index')
    .ifNotExists()
    .on('keepalive_events')
    .column('expires_at')
    .execute()

  await database.schema
    .createIndex('security_audits_expires_at_index')
    .ifNotExists()
    .on('security_audits')
    .column('expires_at')
    .execute()
}

export type ReadonlyColumn<T> = ColumnType<T, T, never>
