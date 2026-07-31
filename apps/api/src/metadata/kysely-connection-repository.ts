import type {
  ConnectionRepository,
  StoredConnectionProfile,
} from '../connections/connection-types.js'
import type { MetadataKysely } from './metadata-database.js'

export class KyselyConnectionRepository implements ConnectionRepository {
  constructor(private readonly database: MetadataKysely) {}

  async create(profile: StoredConnectionProfile): Promise<void> {
    await this.database
      .insertInto('connections')
      .values({
        id: profile.id,
        name: profile.name,
        engine: profile.engine,
        host: profile.host,
        port: profile.port,
        database_name: profile.database,
        username: profile.username,
        tls_mode: profile.tls.mode,
        tls_has_ca: profile.tls.hasCa ? 1 : 0,
        tls_has_client_certificate: profile.tls.hasClientCertificate ? 1 : 0,
        keepalive_enabled: profile.keepAlive.enabled ? 1 : 0,
        keepalive_interval_ms: profile.keepAlive.intervalMs,
        ssh_enabled: profile.ssh?.enabled ? 1 : 0,
        ssh_host: profile.ssh?.enabled ? profile.ssh.host : null,
        ssh_port: profile.ssh?.enabled ? profile.ssh.port : null,
        ssh_username: profile.ssh?.enabled ? profile.ssh.username : null,
        created_by: profile.createdBy,
        created_at: profile.createdAt,
        encrypted_secrets: profile.encryptedSecrets,
      })
      .execute()
  }

  async findById(id: string): Promise<StoredConnectionProfile | undefined> {
    const row = await this.database
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? this.map(row) : undefined
  }

  async list(): Promise<StoredConnectionProfile[]> {
    const rows = await this.database
      .selectFrom('connections')
      .selectAll()
      .orderBy('name', 'asc')
      .execute()
    return rows.map((row) => this.map(row))
  }

  private map(row: {
    id: string
    name: string
    engine: 'postgres' | 'mysql'
    host: string
    port: number
    database_name: string
    username: string
    tls_mode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
    tls_has_ca: number
    tls_has_client_certificate: number
    keepalive_enabled: number
    keepalive_interval_ms: number
    ssh_enabled: number
    ssh_host: string | null
    ssh_port: number | null
    ssh_username: string | null
    created_by: string
    created_at: string
    encrypted_secrets: string
  }): StoredConnectionProfile {
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database_name,
      username: row.username,
      tls: {
        mode: row.tls_mode,
        hasCa: row.tls_has_ca === 1,
        hasClientCertificate: row.tls_has_client_certificate === 1,
      },
      keepAlive: {
        enabled: row.keepalive_enabled === 1,
        intervalMs: row.keepalive_interval_ms,
      },
      ssh: row.ssh_enabled === 1 && row.ssh_host && row.ssh_port && row.ssh_username
        ? {
            enabled: true,
            host: row.ssh_host,
            port: row.ssh_port,
            username: row.ssh_username,
          }
        : { enabled: false },
      createdBy: row.created_by,
      createdAt: row.created_at,
      encryptedSecrets: row.encrypted_secrets,
    }
  }
}
