import type {
  StoredTransferAudit,
  TransferAuditRepository,
} from '../transfers/transfer-audit.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyTransferAuditRepository implements TransferAuditRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(entry: StoredTransferAudit): Promise<void> {
    await this.database.insertInto('transfer_audits').values({
      id: entry.id,
      actor_id: entry.actorId,
      job_id: entry.jobId,
      connection_id: entry.connectionId,
      direction: entry.direction,
      format: entry.format,
      action: entry.action,
      status: entry.status,
      encrypted_details: entry.encryptedDetails,
      error_code: entry.errorCode ?? null,
      created_at: entry.createdAt,
      expires_at: entry.expiresAt,
    }).execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database.deleteFrom('transfer_audits')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0)
  }

  async list(): Promise<StoredTransferAudit[]> {
    const rows = await this.database.selectFrom('transfer_audits')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      jobId: row.job_id,
      connectionId: row.connection_id,
      direction: row.direction,
      format: row.format,
      action: row.action,
      status: row.status,
      encryptedDetails: row.encrypted_details,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
