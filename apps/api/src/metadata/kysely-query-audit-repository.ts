import type {
  QueryAuditRepository,
  StoredQueryAudit,
} from '../audit/query-audit.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyQueryAuditRepository implements QueryAuditRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(entry: StoredQueryAudit): Promise<void> {
    await this.database
      .insertInto('query_audits')
      .values({
        id: entry.id,
        query_id: entry.queryId,
        user_id: entry.userId,
        connection_id: entry.connectionId,
        encrypted_sql: entry.encryptedSql,
        status: entry.status,
        duration_ms: entry.durationMs,
        row_count: entry.rowCount,
        error_code: entry.errorCode ?? null,
        created_at: entry.createdAt,
        expires_at: entry.expiresAt,
      })
      .execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('query_audits')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async list(): Promise<StoredQueryAudit[]> {
    const rows = await this.database
      .selectFrom('query_audits')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      queryId: row.query_id,
      userId: row.user_id,
      connectionId: row.connection_id,
      encryptedSql: row.encrypted_sql,
      status: row.status,
      durationMs: row.duration_ms,
      rowCount: row.row_count,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
