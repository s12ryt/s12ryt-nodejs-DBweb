import { randomUUID } from 'node:crypto'

import type { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type {
  ConnectionInput,
  ConnectionProfile,
  ConnectionRepository,
  DatabaseEngine,
  ResolvedConnection,
  StoredConnectionProfile,
} from './connection-types.js'

type ConnectionErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'INVALID_CONNECTION'
  | 'INVALID_KEEPALIVE_INTERVAL'
  | 'INVALID_SSH_CONFIGURATION'
  | 'INVALID_TLS_CONFIGURATION'

export class ConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode) {
    super(code)
    this.name = 'ConnectionError'
  }
}

export interface DatabaseConnector {
  test(connection: ResolvedConnection): Promise<{ latencyMs: number; serverVersion: string }>
}

interface StoredSecrets {
  password: string
  ca?: string
  certificate?: string
  privateKey?: string
  sshPassword?: string
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 300_000
const MIN_KEEPALIVE_INTERVAL_MS = 60_000
const MAX_KEEPALIVE_INTERVAL_MS = 86_400_000

function toPublicProfile(profile: StoredConnectionProfile): ConnectionProfile {
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    username: profile.username,
    tls: profile.tls,
    keepAlive: profile.keepAlive,
    ssh: profile.ssh ?? { enabled: false },
    createdBy: profile.createdBy,
    createdAt: profile.createdAt,
  }
}

export class ConnectionService {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly connectors: Record<DatabaseEngine, DatabaseConnector>,
  ) {}

  async create(input: ConnectionInput, createdBy: string): Promise<ConnectionProfile> {
    this.validate(input)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const secrets: StoredSecrets = {
      password: input.password,
      ...(input.tls.ca ? { ca: input.tls.ca } : {}),
      ...(input.tls.certificate ? { certificate: input.tls.certificate } : {}),
      ...(input.tls.privateKey ? { privateKey: input.tls.privateKey } : {}),
      ...(input.ssh?.enabled ? { sshPassword: input.ssh.password } : {}),
    }
    const profile: StoredConnectionProfile = {
      id,
      name: input.name.trim(),
      engine: input.engine,
      host: input.host.trim(),
      port: input.port,
      database: input.database.trim(),
      username: input.username.trim(),
      tls: {
        mode: input.tls.mode,
        hasCa: Boolean(input.tls.ca),
        hasClientCertificate: Boolean(input.tls.certificate && input.tls.privateKey),
      },
      keepAlive: {
        enabled: input.keepAlive.enabled,
        intervalMs: input.keepAlive.enabled
          ? (input.keepAlive.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS)
          : DEFAULT_KEEPALIVE_INTERVAL_MS,
      },
      ssh: input.ssh?.enabled
        ? {
            enabled: true,
            host: input.ssh.host.trim(),
            port: input.ssh.port,
            username: input.ssh.username.trim(),
          }
        : { enabled: false },
      createdBy,
      createdAt,
      encryptedSecrets: this.encryption.encrypt(JSON.stringify(secrets), `connection:${id}`),
    }
    await this.repository.create(profile)
    return toPublicProfile(profile)
  }

  async list(): Promise<ConnectionProfile[]> {
    return (await this.repository.list()).map(toPublicProfile)
  }

  async testConnection(id: string): Promise<{ latencyMs: number; serverVersion: string }> {
    const resolved = await this.resolveConnection(id)
    return this.connectors[resolved.engine].test(resolved)
  }

  async resolveConnection(id: string): Promise<ResolvedConnection> {
    const profile = await this.repository.findById(id)
    if (!profile) throw new ConnectionError('CONNECTION_NOT_FOUND')
    const secrets = JSON.parse(
      this.encryption.decrypt(profile.encryptedSecrets, `connection:${id}`),
    ) as StoredSecrets
    const resolved: ResolvedConnection = {
      id: profile.id,
      name: profile.name,
      engine: profile.engine,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      username: profile.username,
      password: secrets.password,
      keepAlive: profile.keepAlive,
      tls: {
        mode: profile.tls.mode,
        ...(secrets.ca ? { ca: secrets.ca } : {}),
        ...(secrets.certificate ? { certificate: secrets.certificate } : {}),
        ...(secrets.privateKey ? { privateKey: secrets.privateKey } : {}),
      },
      ssh: profile.ssh?.enabled
        ? {
            enabled: true,
            host: profile.ssh.host,
            port: profile.ssh.port,
            username: profile.ssh.username,
            password: secrets.sshPassword ?? '',
          }
        : { enabled: false },
    }
    return resolved
  }

  private validate(input: ConnectionInput): void {
    if (
      !input.name.trim() ||
      !input.host.trim() ||
      !input.database.trim() ||
      !input.username.trim() ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65_535
    ) {
      throw new ConnectionError('INVALID_CONNECTION')
    }
    const interval = input.keepAlive.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    if (
      input.keepAlive.enabled &&
      (interval < MIN_KEEPALIVE_INTERVAL_MS || interval > MAX_KEEPALIVE_INTERVAL_MS)
    ) {
      throw new ConnectionError('INVALID_KEEPALIVE_INTERVAL')
    }
    if (Boolean(input.tls.certificate) !== Boolean(input.tls.privateKey)) {
      throw new ConnectionError('INVALID_TLS_CONFIGURATION')
    }
    if (
      input.ssh?.enabled &&
      (
        !input.ssh.host.trim() ||
        !Number.isInteger(input.ssh.port) ||
        input.ssh.port < 1 ||
        input.ssh.port > 65_535 ||
        !input.ssh.username.trim() ||
        !input.ssh.password
      )
    ) {
      throw new ConnectionError('INVALID_SSH_CONFIGURATION')
    }
  }
}
