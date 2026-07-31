export interface SshKnownHost {
  endpoint: string
  fingerprint: string
}

export type SshKnownHostClaimResult = 'claimed' | 'matched' | 'conflict'

export interface SshKnownHostRepository {
  claim(endpoint: string, fingerprint: string): Promise<SshKnownHostClaimResult>
  find(endpoint: string): Promise<SshKnownHost | undefined>
  delete(endpoint: string): Promise<void>
}

export interface SshHostKeyResetEvent {
  actorId: string
  endpoint: string
  createdAt: string
}

export interface SshHostKeyResetRecorder {
  record(event: SshHostKeyResetEvent): Promise<void>
}

export type SshHostKeyErrorCode = 'SSH_HOST_KEY_MISMATCH'

export class SshHostKeyError extends Error {
  constructor(readonly code: SshHostKeyErrorCode) {
    super(code)
    this.name = 'SshHostKeyError'
  }
}

export function normalizeSshEndpoint(host: string, port: number): string {
  let normalizedHost = host.trim().toLowerCase()
  if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']')) {
    normalizedHost = normalizedHost.slice(1, -1)
  }
  normalizedHost = normalizedHost.replace(/\.+$/, '')
  return `[${normalizedHost}]:${port}`
}

export class SshKnownHostService {
  constructor(
    private readonly repository: SshKnownHostRepository,
    private readonly resetRecorder: SshHostKeyResetRecorder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(host: string, port: number, fingerprint: string): Promise<void> {
    const result = await this.repository.claim(normalizeSshEndpoint(host, port), fingerprint)
    if (result === 'conflict') throw new SshHostKeyError('SSH_HOST_KEY_MISMATCH')
  }

  async reset(host: string, port: number, actorId: string): Promise<void> {
    const endpoint = normalizeSshEndpoint(host, port)
    await this.repository.delete(endpoint)
    await this.resetRecorder.record({
      actorId,
      endpoint,
      createdAt: this.now().toISOString(),
    })
  }
}

export class MemorySshKnownHostRepository implements SshKnownHostRepository {
  private readonly hosts = new Map<string, string>()

  async claim(endpoint: string, fingerprint: string): Promise<SshKnownHostClaimResult> {
    const existing = this.hosts.get(endpoint)
    if (existing === undefined) {
      this.hosts.set(endpoint, fingerprint)
      return 'claimed'
    }
    return existing === fingerprint ? 'matched' : 'conflict'
  }

  async find(endpoint: string): Promise<SshKnownHost | undefined> {
    const fingerprint = this.hosts.get(endpoint)
    return fingerprint === undefined ? undefined : { endpoint, fingerprint }
  }

  async delete(endpoint: string): Promise<void> {
    this.hosts.delete(endpoint)
  }
}

export class MemorySshHostKeyResetRecorder implements SshHostKeyResetRecorder {
  readonly events: SshHostKeyResetEvent[] = []

  async record(event: SshHostKeyResetEvent): Promise<void> {
    this.events.push(structuredClone(event))
  }
}
