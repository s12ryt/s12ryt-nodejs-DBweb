import type {
  MutationAuditRepository,
  StoredMutationAudit,
} from '../data/mutation-audit.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyMutationAuditRepository implements MutationAuditRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(entry: StoredMutationAudit): Promise<void> {
    await this.database.insertInto('mutation_audits').values({
      id: entry.id,
      actor_id: entry.actorId,
      connection_id: entry.connectionId,
      object_type: entry.objectType,
      object_name: entry.objectName,
      action: entry.action,
      operation_count: entry.operationCount,
      affected_rows: entry.affectedRows,
      status: entry.status,
      encrypted_sql_templates: entry.encryptedSqlTemplates,
      error_code: entry.errorCode ?? null,
      created_at: entry.createdAt,
      expires_at: entry.expiresAt,
    }).execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('mutation_audits')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async list(): Promise<StoredMutationAudit[]> {
    const rows = await this.database
      .selectFrom('mutation_audits')
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
      operationCount: row.operation_count,
      affectedRows: row.affected_rows,
      status: row.status,
      encryptedSqlTemplates: row.encrypted_sql_templates,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
