import { randomUUID } from 'node:crypto'

import type {
  SshHostKeyResetEvent,
  SshHostKeyResetRecorder,
  SshKnownHost,
  SshKnownHostClaimResult,
  SshKnownHostRepository,
} from '../ssh/ssh-known-host-service.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselySshKnownHostRepository implements SshKnownHostRepository {
  constructor(
    private readonly database: MetadataKysely,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(endpoint: string, fingerprint: string): Promise<SshKnownHostClaimResult> {
    const result = await this.database
      .insertInto('ssh_known_hosts')
      .values({ endpoint, fingerprint, created_at: this.now().toISOString() })
      .onConflict((conflict) => conflict.column('endpoint').doNothing())
      .executeTakeFirst()

    if (Number(result.numInsertedOrUpdatedRows) === 1) return 'claimed'
    const existing = await this.find(endpoint)
    return existing?.fingerprint === fingerprint ? 'matched' : 'conflict'
  }

  async find(endpoint: string): Promise<SshKnownHost | undefined> {
    const row = await this.database
      .selectFrom('ssh_known_hosts')
      .select(['endpoint', 'fingerprint'])
      .where('endpoint', '=', endpoint)
      .executeTakeFirst()
    return row ?? undefined
  }

  async delete(endpoint: string): Promise<void> {
    await this.database.deleteFrom('ssh_known_hosts').where('endpoint', '=', endpoint).execute()
  }
}

export class KyselySshHostKeyResetRecorder implements SshHostKeyResetRecorder {
  constructor(private readonly database: MetadataKysely) {}

  async record(event: SshHostKeyResetEvent): Promise<void> {
    await this.database
      .insertInto('ssh_host_key_resets')
      .values({
        id: randomUUID(),
        endpoint: event.endpoint,
        actor_id: event.actorId,
        created_at: event.createdAt,
      })
      .execute()
  }

  async list(): Promise<SshHostKeyResetEvent[]> {
    const rows = await this.database
      .selectFrom('ssh_host_key_resets')
      .select(['endpoint', 'actor_id', 'created_at'])
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => ({
      actorId: row.actor_id,
      endpoint: row.endpoint,
      createdAt: row.created_at,
    }))
  }
}
