import type {
  SecurityAuditRepository,
  StoredSecurityAudit,
} from '../security/security-audit.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselySecurityAuditRepository implements SecurityAuditRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(event: StoredSecurityAudit): Promise<void> {
    await this.database
      .insertInto('security_audits')
      .values({
        id: event.id,
        actor_id: event.actorId,
        target_user_id: event.targetUserId ?? null,
        connection_id: event.connectionId ?? null,
        action: event.action,
        status: event.status,
        encrypted_details: event.encryptedDetails,
        error_code: event.errorCode ?? null,
        created_at: event.createdAt,
        expires_at: event.expiresAt,
      })
      .execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('security_audits')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async list(): Promise<StoredSecurityAudit[]> {
    const rows = await this.database
      .selectFrom('security_audits')
      .selectAll()
      .orderBy('created_at')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      ...(row.target_user_id ? { targetUserId: row.target_user_id } : {}),
      ...(row.connection_id ? { connectionId: row.connection_id } : {}),
      action: row.action,
      status: row.status,
      encryptedDetails: row.encrypted_details,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
