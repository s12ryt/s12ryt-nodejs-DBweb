import type { DdlAuditRepository, StoredDdlAudit } from '../ddl/ddl-audit.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyDdlAuditRepository implements DdlAuditRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(entry: StoredDdlAudit): Promise<void> {
    await this.database.insertInto('ddl_audits').values({
      id: entry.id,
      actor_id: entry.actorId,
      connection_id: entry.connectionId,
      object_type: entry.objectType,
      object_name: entry.objectName,
      action: entry.action,
      statement_count: entry.statementCount,
      transactional: entry.transactional ? 1 : 0,
      status: entry.status,
      encrypted_sql_templates: entry.encryptedSqlTemplates,
      error_code: entry.errorCode ?? null,
      created_at: entry.createdAt,
      expires_at: entry.expiresAt,
    }).execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('ddl_audits')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async list(): Promise<StoredDdlAudit[]> {
    const rows = await this.database
      .selectFrom('ddl_audits')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      connectionId: row.connection_id,
      objectType: row.object_type,
      objectName: row.object_name,
      action: row.action,
      statementCount: row.statement_count,
      transactional: row.transactional === 1,
      status: row.status,
      encryptedSqlTemplates: row.encrypted_sql_templates,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
