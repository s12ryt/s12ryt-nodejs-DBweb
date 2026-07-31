import type {
  KeepAliveEventRepository,
  StoredKeepAliveEvent,
} from '../keepalive/keepalive-event.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyKeepAliveEventRepository implements KeepAliveEventRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(event: StoredKeepAliveEvent): Promise<void> {
    await this.database
      .insertInto('keepalive_events')
      .values({
        id: event.id,
        connection_id: event.connectionId,
        status: event.status,
        duration_ms: event.durationMs,
        created_at: event.createdAt,
        expires_at: event.expiresAt,
      })
      .execute()
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('keepalive_events')
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async list(): Promise<StoredKeepAliveEvent[]> {
    const rows = await this.database
      .selectFrom('keepalive_events')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      status: row.status,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
