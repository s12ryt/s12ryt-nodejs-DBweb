import type {
  StoredTransferPreviewPlan,
  TransferPreviewPlanRepository,
} from '../transfers/transfer-preview-plan.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyTransferPreviewPlanRepository implements TransferPreviewPlanRepository {
  constructor(private readonly database: MetadataKysely) {}

  async save(plan: StoredTransferPreviewPlan): Promise<void> {
    await this.database.insertInto('transfer_preview_plans').values({
      job_id: plan.jobId,
      encrypted_payload: plan.encryptedPayload,
      expires_at: plan.expiresAt,
      updated_at: plan.updatedAt,
    }).onConflict((conflict) => conflict.column('job_id').doUpdateSet({
      encrypted_payload: plan.encryptedPayload,
      expires_at: plan.expiresAt,
      updated_at: plan.updatedAt,
    })).execute()
  }

  async find(jobId: string): Promise<StoredTransferPreviewPlan | undefined> {
    const row = await this.database.selectFrom('transfer_preview_plans')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirst()
    return row ? {
      jobId: row.job_id,
      encryptedPayload: row.encrypted_payload,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    } : undefined
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database.deleteFrom('transfer_preview_plans')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0)
  }
}
