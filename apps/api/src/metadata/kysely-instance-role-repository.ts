import { sql } from 'kysely'

import type {
  InstanceRoleLease,
  InstanceRoleRepository,
} from '../ha/instance-role-service.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyInstanceRoleRepository implements InstanceRoleRepository {
  constructor(private readonly database: MetadataKysely) {}

  async heartbeat(
    instanceId: string,
    now: Date,
    leaseDurationMs: number,
    activeLimit: number,
  ): Promise<InstanceRoleLease> {
    return this.database.transaction().execute(async (transaction) => {
      await transaction.updateTable('ha_instance_lock')
        .set({ revision: sql<number>`revision + 1` })
        .where('id', '=', 1)
        .executeTakeFirstOrThrow()

      const nowIso = now.toISOString()
      const existing = await transaction.selectFrom('ha_instance_leases')
        .selectAll()
        .where('instance_id', '=', instanceId)
        .executeTakeFirst()
      const activeCount = await transaction.selectFrom('ha_instance_leases')
        .select(({ fn }) => fn.count<number>('instance_id').as('count'))
        .where('instance_id', '!=', instanceId)
        .where('role', '=', 'active')
        .where('lease_expires_at', '>', nowIso)
        .executeTakeFirstOrThrow()
      const remainsActive = existing?.role === 'active' && existing.lease_expires_at > nowIso
      const role = remainsActive || Number(activeCount.count) < activeLimit
        ? 'active'
        : 'standby'
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)
      const row = {
        instance_id: instanceId,
        role,
        lease_expires_at: leaseExpiresAt.toISOString(),
        updated_at: nowIso,
      } as const
      await transaction.insertInto('ha_instance_leases')
        .values(row)
        .onConflict((conflict) => conflict.column('instance_id').doUpdateSet(row))
        .execute()
      return { instanceId, role, leaseExpiresAt }
    })
  }

  async release(instanceId: string): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction.updateTable('ha_instance_lock')
        .set({ revision: sql<number>`revision + 1` })
        .where('id', '=', 1)
        .executeTakeFirstOrThrow()
      await transaction.deleteFrom('ha_instance_leases')
        .where('instance_id', '=', instanceId)
        .execute()
    })
  }
}
