import { sql, type Transaction } from 'kysely'

import type {
  DatabaseOperationLease,
  DatabaseOperationLeaseMutationResult,
  DatabaseOperationLeaseRepository,
} from '../ha/database-operation-gate.js'
import type { MetadataDatabase, MetadataKysely } from './metadata-database.js'

type MetadataTransaction = Transaction<MetadataDatabase>

export class KyselyDatabaseOperationLeaseRepository
implements DatabaseOperationLeaseRepository {
  constructor(private readonly database: MetadataKysely) {}

  async tryAcquire(
    lease: DatabaseOperationLease,
    now: string,
    globalLimit: number,
    connectionLimit: number,
  ): Promise<DatabaseOperationLease | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lock(transaction)
      await transaction.deleteFrom('database_operation_leases')
        .where('expires_at', '<=', now)
        .execute()

      const globalCount = await transaction.selectFrom('database_operation_leases')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow()
      if (Number(globalCount.count) >= globalLimit) return undefined

      const connectionCount = await transaction.selectFrom('database_operation_leases')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .where('connection_id', '=', lease.connectionId)
        .executeTakeFirstOrThrow()
      if (Number(connectionCount.count) >= connectionLimit) return undefined

      await transaction.insertInto('database_operation_leases').values({
        id: lease.id,
        owner_id: lease.ownerId,
        connection_id: lease.connectionId,
        acquired_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
      }).executeTakeFirstOrThrow()
      return structuredClone(lease)
    })
  }

  async heartbeat(
    leaseId: string,
    ownerId: string,
    now: string,
    expiresAt: string,
  ): Promise<DatabaseOperationLeaseMutationResult> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lock(transaction)
      const row = await transaction.selectFrom('database_operation_leases')
        .selectAll()
        .where('id', '=', leaseId)
        .executeTakeFirst()
      if (!row) return 'not-found'
      if (row.owner_id !== ownerId) return 'not-owned'
      if (row.expires_at <= now) {
        await transaction.deleteFrom('database_operation_leases').where('id', '=', leaseId).execute()
        return 'expired'
      }
      await transaction.updateTable('database_operation_leases')
        .set({ expires_at: expiresAt })
        .where('id', '=', leaseId)
        .executeTakeFirstOrThrow()
      return 'updated'
    })
  }

  async release(
    leaseId: string,
    ownerId: string,
  ): Promise<DatabaseOperationLeaseMutationResult> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lock(transaction)
      const row = await transaction.selectFrom('database_operation_leases')
        .select(['owner_id'])
        .where('id', '=', leaseId)
        .executeTakeFirst()
      if (!row) return 'not-found'
      if (row.owner_id !== ownerId) return 'not-owned'
      await transaction.deleteFrom('database_operation_leases').where('id', '=', leaseId).execute()
      return 'updated'
    })
  }

  private async lock(transaction: MetadataTransaction): Promise<void> {
    await transaction.updateTable('database_operation_lock')
      .set({ revision: sql<number>`revision + 1` })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow()
  }
}
