import { sql } from 'kysely'

import type {
  StoredTransferJob,
  TransferJobRepository,
  TransferJobStatus,
} from '../transfers/transfer-job.js'
import type { MetadataDatabase, MetadataKysely } from './metadata-database.js'

type TransferJobRow = MetadataDatabase['transfer_jobs']

const ACTIVE_STATUSES: TransferJobStatus[] = ['queued', 'previewed', 'running']

export class KyselyTransferJobRepository implements TransferJobRepository {
  constructor(private readonly database: MetadataKysely) {}

  async createWithinLimits(
    job: StoredTransferJob,
    ownerLimit: number,
    connectionLimit: number,
  ): Promise<'created' | 'owner-limit' | 'connection-limit'> {
    return await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('transfer_job_lock')
        .set({ revision: sql<number>`revision + 1` })
        .where('id', '=', 1)
        .execute()

      const ownerCount = await transaction
        .selectFrom('transfer_jobs')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('owner_id', '=', job.ownerId)
        .where('status', 'in', ACTIVE_STATUSES)
        .executeTakeFirstOrThrow()
      if (Number(ownerCount.count) >= ownerLimit) return 'owner-limit'

      const connectionCount = await transaction
        .selectFrom('transfer_jobs')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('connection_id', '=', job.connectionId)
        .where('status', 'in', ACTIVE_STATUSES)
        .executeTakeFirstOrThrow()
      if (Number(connectionCount.count) >= connectionLimit) return 'connection-limit'

      await transaction.insertInto('transfer_jobs').values(this.values(job)).execute()
      return 'created'
    })
  }

  async findById(id: string): Promise<StoredTransferJob | undefined> {
    const row = await this.database
      .selectFrom('transfer_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? this.map(row) : undefined
  }

  async listByOwner(ownerId: string): Promise<StoredTransferJob[]> {
    const rows = await this.database
      .selectFrom('transfer_jobs')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map((row) => this.map(row))
  }

  async listAll(): Promise<StoredTransferJob[]> {
    const rows = await this.database
      .selectFrom('transfer_jobs')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map((row) => this.map(row))
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database.deleteFrom('transfer_jobs')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0)
  }

  async replace(
    job: StoredTransferJob,
    expectedStatus: TransferJobStatus,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    const result = await this.database
      .updateTable('transfer_jobs')
      .set(this.values(job))
      .where('id', '=', job.id)
      .where('status', '=', expectedStatus)
      .where('updated_at', '=', expectedUpdatedAt)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  private values(job: StoredTransferJob): TransferJobRow {
    return {
      id: job.id,
      owner_id: job.ownerId,
      connection_id: job.connectionId,
      direction: job.direction,
      format: job.format,
      include_data: job.includeData ? 1 : 0,
      status: job.status,
      received_bytes: job.receivedBytes,
      processed_bytes: job.processedBytes,
      processed_rows: job.processedRows,
      processed_tables: job.processedTables,
      error_count: job.errorCount,
      source_bytes: job.sourceBytes ?? null,
      source_checksum: job.sourceChecksum ?? null,
      upload_completed_at: job.uploadCompletedAt ?? null,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      expires_at: job.expiresAt,
    }
  }

  private map(row: TransferJobRow): StoredTransferJob {
    return {
      id: row.id,
      ownerId: row.owner_id,
      connectionId: row.connection_id,
      direction: row.direction,
      format: row.format,
      includeData: Boolean(row.include_data),
      status: row.status,
      receivedBytes: row.received_bytes,
      processedBytes: row.processed_bytes,
      processedRows: row.processed_rows,
      processedTables: row.processed_tables,
      errorCount: row.error_count,
      ...(row.source_bytes === null ? {} : { sourceBytes: row.source_bytes }),
      ...(row.source_checksum === null ? {} : { sourceChecksum: row.source_checksum }),
      ...(row.upload_completed_at === null ? {} : { uploadCompletedAt: row.upload_completed_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    }
  }
}
