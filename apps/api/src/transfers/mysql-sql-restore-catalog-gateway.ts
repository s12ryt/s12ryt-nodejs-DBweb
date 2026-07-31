import type { Duplex } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { SqlDumpManifest, SqlDumpObjectKind } from './sql-dump-manifest.js'
import type { SqlRestoreCatalogGateway } from './sql-restore-preview.js'
import { SqlRestoreExecutionError } from './sql-restore-service.js'

const CATALOG_SQL = `
SELECT CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS dbweb_kind,
       t.TABLE_SCHEMA AS dbweb_schema, t.TABLE_NAME AS dbweb_name
FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = ?
UNION ALL
SELECT lower(r.ROUTINE_TYPE), r.ROUTINE_SCHEMA, r.ROUTINE_NAME
FROM information_schema.ROUTINES r WHERE r.ROUTINE_SCHEMA = ?
UNION ALL
SELECT 'trigger', t.TRIGGER_SCHEMA, t.TRIGGER_NAME
FROM information_schema.TRIGGERS t WHERE t.TRIGGER_SCHEMA = ?
UNION ALL
SELECT 'event', e.EVENT_SCHEMA, e.EVENT_NAME
FROM information_schema.EVENTS e WHERE e.EVENT_SCHEMA = ?
UNION ALL
SELECT 'index', s.TABLE_SCHEMA, s.INDEX_NAME
FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA = ?
UNION ALL
SELECT 'constraint', c.CONSTRAINT_SCHEMA, c.CONSTRAINT_NAME
FROM information_schema.TABLE_CONSTRAINTS c WHERE c.CONSTRAINT_SCHEMA = ?
UNION ALL
SELECT 'partition', p.TABLE_SCHEMA, p.PARTITION_NAME
FROM information_schema.PARTITIONS p
WHERE p.TABLE_SCHEMA = ? AND p.PARTITION_NAME IS NOT NULL`

export interface MysqlSqlRestoreCatalogConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
}

export type MysqlSqlRestoreCatalogConnectionFactory = (
  options: MysqlClientOptions,
) => Promise<MysqlSqlRestoreCatalogConnection>

export class MysqlSqlRestoreCatalogGateway implements SqlRestoreCatalogGateway {
  constructor(
    private readonly createConnection: MysqlSqlRestoreCatalogConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions) as unknown as MysqlSqlRestoreCatalogConnection,
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  serverVersion(connection: ResolvedConnection, targetDatabase: string): Promise<string> {
    return this.withClient(connection, targetDatabase, async (client) => {
      const [rawRows] = await client.query('SELECT VERSION() AS dbweb_version')
      if (!Array.isArray(rawRows)) throw new Error('INVALID_VERSION')
      const version = (rawRows[0] as Record<string, unknown> | undefined)?.dbweb_version
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
      const [rawRows] = await client.query(CATALOG_SQL, Array(7).fill(targetDatabase))
      if (!Array.isArray(rawRows)) throw new Error('INVALID_CATALOG')
      const keys = new Set(rawRows.map(catalogKey).filter((key): key is string => key !== undefined))
      return manifest.objects.filter((object) => keys.has(objectKey(object.kind, object.schema, object.name)))
        .map((object) => object.id)
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    targetDatabase: string,
    operation: (client: MysqlSqlRestoreCatalogConnection) => Promise<T>,
  ): Promise<T> {
    let socket: Duplex | undefined
    let client: MysqlSqlRestoreCatalogConnection | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection(mysqlClientOptions({ ...connection, database: targetDatabase }, socket))
      return await operation(client)
    } catch {
      throw new SqlRestoreExecutionError('RESTORE_FAILED')
    } finally {
      try { await client?.end() } catch { /* Cleanup cannot replace the catalog result. */ }
      socket?.destroy()
    }
  }
}

function catalogKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.dbweb_kind !== 'string' || typeof row.dbweb_schema !== 'string' || typeof row.dbweb_name !== 'string') {
    return undefined
  }
  return objectKey(row.dbweb_kind as SqlDumpObjectKind, row.dbweb_schema, row.dbweb_name)
}

function objectKey(kind: SqlDumpObjectKind, schema: string | undefined, name: string): string {
  return JSON.stringify([kind, schema ?? '', name])
}
