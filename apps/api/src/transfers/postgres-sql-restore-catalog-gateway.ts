import type { Duplex } from 'node:stream'

import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { postgresClientConfig, type PostgresClientFactory, type PostgresClientLike } from '../connections/postgres-connector.js'
import type { SqlDumpManifest, SqlDumpObjectKind } from './sql-dump-manifest.js'
import type { SqlRestoreCatalogGateway } from './sql-restore-preview.js'
import { SqlRestoreExecutionError } from './sql-restore-service.js'

const CATALOG_SQL = `
SELECT 'schema' AS dbweb_kind, n.nspname AS dbweb_schema, n.nspname AS dbweb_name
FROM pg_catalog.pg_namespace n
UNION ALL
SELECT CASE
  WHEN c.relkind = 'v' THEN 'view'
  WHEN c.relkind = 'm' THEN 'materialized-view'
  WHEN c.relkind = 'S' THEN 'sequence'
  WHEN c.relkind = 'i' THEN 'index'
  WHEN c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid) THEN 'partition'
  ELSE 'table'
END AS dbweb_kind, n.nspname AS dbweb_schema, c.relname AS dbweb_name
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'v', 'm', 'S', 'i')
UNION ALL
SELECT CASE WHEN t.typtype = 'd' THEN 'domain' ELSE 'type' END,
       n.nspname, t.typname
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype IN ('d', 'e')
UNION ALL
SELECT 'constraint', n.nspname, c.conname
FROM pg_catalog.pg_constraint c
JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
UNION ALL
SELECT lower(r.routine_type), r.routine_schema, r.routine_name
FROM information_schema.routines r
UNION ALL
SELECT 'trigger', n.nspname, t.tgname
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
UNION ALL
SELECT 'extension', '' AS dbweb_schema, e.extname
FROM pg_catalog.pg_extension e`

interface CatalogRow {
  dbweb_kind?: unknown
  dbweb_schema?: unknown
  dbweb_name?: unknown
}

export class PostgresSqlRestoreCatalogGateway implements SqlRestoreCatalogGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  serverVersion(connection: ResolvedConnection, targetDatabase: string): Promise<string> {
    return this.withClient(connection, targetDatabase, async (client) => {
      const result = await client.query('SHOW server_version')
      const version = result.rows[0]?.server_version
      if (typeof version !== 'string' || !version) throw new Error('INVALID_VERSION')
      return version
    })
  }

  listExistingObjectIds(
    connection: ResolvedConnection,
    targetDatabase: string,
    manifest: SqlDumpManifest,
  ): Promise<string[]> {
    return this.withClient(connection, targetDatabase, async (client) => {
      const result = await client.query(CATALOG_SQL)
      const keys = new Set(result.rows.map(catalogKey).filter((key): key is string => key !== undefined))
      return manifest.objects.filter((object) => keys.has(objectKey(object.kind, object.schema, object.name)))
        .map((object) => object.id)
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    targetDatabase: string,
    operation: (client: PostgresClientLike) => Promise<T>,
  ): Promise<T> {
    let socket: Duplex | undefined
    let client: PostgresClientLike | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig({ ...connection, database: targetDatabase }, socket))
      await client.connect()
      return await operation(client)
    } catch {
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    } finally {
      try { await client?.end() } catch { /* Cleanup cannot replace the catalog result. */ }
      socket?.destroy()
    }
  }
}

function catalogKey(row: Record<string, unknown>): string | undefined {
  const typed = row as CatalogRow
  if (typeof typed.dbweb_kind !== 'string' || typeof typed.dbweb_schema !== 'string' || typeof typed.dbweb_name !== 'string') {
    return undefined
  }
  return objectKey(typed.dbweb_kind as SqlDumpObjectKind, typed.dbweb_schema, typed.dbweb_name)
}

function objectKey(kind: SqlDumpObjectKind, schema: string | undefined, name: string): string {
  return JSON.stringify([kind, schema ?? '', name])
}
