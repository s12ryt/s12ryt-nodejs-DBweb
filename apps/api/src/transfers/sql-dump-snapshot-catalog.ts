import type { ResolvedConnection } from '../connections/connection-types.js'
import type {
  SqlDumpExportCatalog,
  SqlDumpExportCatalogResult,
  SqlDumpExportPlan,
} from './sql-dump-export-service.js'

export class SqlDumpSnapshotCatalogError extends Error {
  constructor(readonly code: 'SQL_DUMP_CATALOG_FAILED') {
    super(code)
    this.name = 'SqlDumpSnapshotCatalogError'
  }
}

export interface SqlDumpSnapshotSession {
  begin(signal: AbortSignal): Promise<void>
  inspect(plan: SqlDumpExportPlan, signal: AbortSignal): Promise<SqlDumpExportCatalogResult>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): Promise<void>
}

export interface SqlDumpSnapshotSessionFactory {
  open(connection: ResolvedConnection): Promise<SqlDumpSnapshotSession>
}

export class SqlDumpSnapshotCatalog implements SqlDumpExportCatalog {
  constructor(private readonly sessions: SqlDumpSnapshotSessionFactory) {}

  async withSnapshot<T>(
    connection: ResolvedConnection,
    plan: SqlDumpExportPlan,
    signal: AbortSignal,
    consume: (catalog: SqlDumpExportCatalogResult) => Promise<T>,
  ): Promise<T> {
    let session: SqlDumpSnapshotSession | undefined
    let began = false
    try {
      session = await this.sessions.open(connection)
      throwIfAborted(signal)
      await session.begin(signal)
      began = true
      const catalog = await session.inspect(plan, signal)
      throwIfAborted(signal)
      const result = await consume(catalog)
      throwIfAborted(signal)
      await session.commit()
      began = false
      return result
    } catch {
      if (began) {
        try { await session?.rollback() } catch { /* Preserve the safe catalog error. */ }
      }
      throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
    } finally {
      try { await session?.close() } catch { /* Cleanup cannot expose driver details. */ }
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
}
