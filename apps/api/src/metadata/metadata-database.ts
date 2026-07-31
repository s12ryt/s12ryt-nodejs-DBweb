import Database from 'better-sqlite3'
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type ColumnType,
} from 'kysely'
import { Pool } from 'pg'

interface UsersTable {
  id: string
  username: string
  normalized_username: string
  password_hash: string
  role: 'admin' | 'user'
  created_at: string
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

export interface MetadataDatabase {
  users: UsersTable
  sessions: SessionsTable
  connections: ConnectionsTable
  keepalive_events: KeepAliveEventsTable
  query_audits: QueryAuditsTable
  ssh_host_key_resets: SshHostKeyResetsTable
  ssh_known_hosts: SshKnownHostsTable
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
    .addColumn('created_at', 'varchar(35)', (column) => column.notNull())
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
    .createIndex('query_audits_expires_at_index')
    .ifNotExists()
    .on('query_audits')
    .column('expires_at')
    .execute()

  await database.schema
    .createIndex('keepalive_events_expires_at_index')
    .ifNotExists()
    .on('keepalive_events')
    .column('expires_at')
    .execute()
}

export type ReadonlyColumn<T> = ColumnType<T, T, never>
