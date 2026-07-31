import { sql, type Transaction } from 'kysely'

import type { StoredTransferJob } from '../transfers/transfer-job.js'
import type {
  TransferWorkerLeaseMutationResult,
  TransferWorkerLeaseRepository,
} from '../transfers/transfer-worker-lease.js'
import type { MetadataDatabase, MetadataKysely } from './metadata-database.js'

type TransferJobRow = MetadataDatabase['transfer_jobs']
type MetadataTransaction = Transaction<MetadataDatabase>

export class KyselyTransferWorkerLeaseRepository implements TransferWorkerLeaseRepository {
  constructor(private readonly database: MetadataKysely) {}

  async claim(workerId: string, now: string, leaseExpiresAt: string): Promise<StoredTransferJob | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lock(transaction)
      const row = await transaction
        .selectFrom('transfer_jobs')
        .selectAll()
        .where('attempt_count', '<', 5)
        .where('execution_requested_at', 'is not', null)
        .where('execution_requested_by', 'is not', null)
        .where((expression) => expression.or([
          expression.and([
            expression('status', '=', 'previewed'),
            expression.or([
              expression('lease_expires_at', 'is', null),
              expression('lease_expires_at', '<=', now),
            ]),
            expression.or([
              expression('next_attempt_at', 'is', null),
              expression('next_attempt_at', '<=', now),
            ]),
          ]),
          expression.and([
            expression('status', '=', 'running'),
            expression('lease_expires_at', 'is not', null),
            expression('lease_expires_at', '<=', now),
          ]),
        ]))
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst()
      if (!row) return undefined

      const updatedAt = nextUpdatedAt(row.updated_at, now)
      await transaction.updateTable('transfer_jobs').set({
        status: 'previewed',
        lease_owner: workerId,
        lease_expires_at: leaseExpiresAt,
        attempt_count: row.attempt_count + 1,
        next_attempt_at: null,
        updated_at: updatedAt,
      }).where('id', '=', row.id).executeTakeFirstOrThrow()
      return mapJob({
        ...row,
        status: 'previewed',
        lease_owner: workerId,
        lease_expires_at: leaseExpiresAt,
        attempt_count: row.attempt_count + 1,
        next_attempt_at: null,
        updated_at: updatedAt,
      })
    })
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.mutateOwned(jobId, workerId, now, (row) => ({
      ...row,
      lease_expires_at: leaseExpiresAt,
      updated_at: nextUpdatedAt(row.updated_at, now),
    }), ['previewed', 'running'])
  }

  async complete(
    jobId: string,
    workerId: string,
    now: string,
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.mutateOwned(jobId, workerId, now, (row) => ({
      ...row,
      status: 'succeeded',
      lease_owner: null,
      lease_expires_at: null,
        next_attempt_at: null,
        execution_requested_at: null,
        execution_requested_by: null,
        updated_at: nextUpdatedAt(row.updated_at, now),
    }))
  }

  async fail(
    jobId: string,
    workerId: string,
    now: string,
    maximumAttempts: number,
    retryBaseMs: number,
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.mutateOwned(jobId, workerId, now, (row) => {
      const terminal = row.attempt_count >= maximumAttempts
      return {
        ...row,
        status: terminal ? 'failed' : 'previewed',
        error_count: row.error_count + 1,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: terminal
          ? null
          : new Date(Date.parse(now) + retryBaseMs * (2 ** Math.max(0, row.attempt_count - 1)))
            .toISOString(),
        updated_at: nextUpdatedAt(row.updated_at, now),
      }
    })
  }

  private async mutateOwned(
    jobId: string,
    workerId: string,
    now: string,
    mutate: (row: TransferJobRow) => TransferJobRow,
    allowedStatuses?: TransferJobRow['status'][],
  ): Promise<TransferWorkerLeaseMutationResult> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lock(transaction)
      const row = await transaction.selectFrom('transfer_jobs').selectAll()
        .where('id', '=', jobId).executeTakeFirst()
      if (!row) return { result: 'not-found' }
      if (row.lease_owner !== workerId) return { result: 'not-owned' }
      if (allowedStatuses && !allowedStatuses.includes(row.status)) return { result: 'not-owned' }
      if (!row.lease_expires_at || row.lease_expires_at <= now) return { result: 'expired' }
      const updated = mutate(row)
      await transaction.updateTable('transfer_jobs').set(updated)
        .where('id', '=', jobId).executeTakeFirstOrThrow()
      return { result: 'updated', job: mapJob(updated) }
    })
  }

  private async lock(transaction: MetadataTransaction): Promise<void> {
    await transaction.updateTable('transfer_job_lock')
      .set({ revision: sql<number>`revision + 1` })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow()
  }
}

function mapJob(row: TransferJobRow): StoredTransferJob {
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
    ...(row.execution_requested_at === null ? {} : { executionRequestedAt: row.execution_requested_at }),
    ...(row.execution_requested_by === null ? {} : { executionRequestedBy: row.execution_requested_by }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    attemptCount: row.attempt_count,
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

function nextUpdatedAt(current: string, requested: string): string {
  return new Date(Math.max(Date.parse(requested), Date.parse(current) + 1)).toISOString()
}
