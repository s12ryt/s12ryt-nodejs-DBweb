export type DatabaseEngine = 'postgres' | 'mysql'
export type TlsMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

export interface ConnectionTlsInput {
  mode: TlsMode
  ca?: string
  certificate?: string
  privateKey?: string
}

export type ConnectionSshInput =
  | { enabled: false }
  | {
      enabled: true
      host: string
      port: number
      username: string
      password: string
    }

export type ConnectionSshProfile =
  | { enabled: false }
  | {
      enabled: true
      host: string
      port: number
      username: string
    }

export type ResolvedConnectionSsh =
  | { enabled: false }
  | {
      enabled: true
      host: string
      port: number
      username: string
      password: string
    }

export interface ConnectionInput {
  name: string
  engine: DatabaseEngine
  host: string
  port: number
  database: string
  username: string
  password: string
  tls: ConnectionTlsInput
  keepAlive: { enabled: boolean; intervalMs?: number }
  ssh?: ConnectionSshInput
}

export interface ConnectionProfile {
  id: string
  name: string
  engine: DatabaseEngine
  host: string
  port: number
  database: string
  username: string
  tls: { mode: TlsMode; hasCa: boolean; hasClientCertificate: boolean }
  keepAlive: { enabled: boolean; intervalMs: number }
  ssh?: ConnectionSshProfile
  createdBy: string
  createdAt: string
}

export interface StoredConnectionProfile extends ConnectionProfile {
  encryptedSecrets: string
}

export interface ResolvedConnection extends Omit<ConnectionProfile, 'tls' | 'createdBy' | 'createdAt'> {
  password: string
  tls: ConnectionTlsInput
  ssh?: ResolvedConnectionSsh
}

export interface ConnectionRepository {
  create(profile: StoredConnectionProfile): Promise<void>
  findById(id: string): Promise<StoredConnectionProfile | undefined>
  list(): Promise<StoredConnectionProfile[]>
}
