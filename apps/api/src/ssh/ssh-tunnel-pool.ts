import { createHmac } from 'node:crypto'
import type { Duplex } from 'node:stream'

import { normalizeSshEndpoint } from './ssh-known-host-service.js'

export interface SshTransportConnectOptions {
  host: string
  port: number
  username: string
  password: string
}

export interface SshForwardTarget {
  host: string
  port: number
}

export interface SshTransport {
  forwardOut(target: SshForwardTarget): Promise<Duplex>
  close(): void
  onClose(listener: () => void): () => void
}

export interface SshTransportFactory {
  connect(options: SshTransportConnectOptions): Promise<SshTransport>
}

export interface SshTunnelRequest {
  ssh: SshTransportConnectOptions
  target: SshForwardTarget
}

export type SshTunnelErrorCode = 'SSH_TUNNEL_BUSY' | 'SSH_TUNNEL_CLOSED' | 'SSH_TUNNEL_FAILED'

export class SshTunnelError extends Error {
  constructor(readonly code: SshTunnelErrorCode) {
    super(code)
    this.name = 'SshTunnelError'
  }
}

interface WaitingChannel {
  resolve: () => void
  reject: (error: SshTunnelError) => void
  timer: ReturnType<typeof setTimeout>
}

interface PoolEntry {
  key: string
  transport: SshTransport
  activeChannels: number
  waiters: WaitingChannel[]
  idleTimer: ReturnType<typeof setTimeout> | undefined
  closed: boolean
  unsubscribe: () => void
}

export interface SshTunnelPoolOptions {
  maxChannels?: number
  queueTimeoutMs?: number
  idleTimeoutMs?: number
  forwardTimeoutMs?: number
}

export class SshTunnelPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly connecting = new Map<string, Promise<PoolEntry>>()
  private readonly maxChannels: number
  private readonly queueTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly forwardTimeoutMs: number
  private closing = false

  constructor(
    private readonly factory: SshTransportFactory,
    private readonly credentialKey: Buffer,
    options: SshTunnelPoolOptions = {},
  ) {
    this.maxChannels = options.maxChannels ?? 20
    this.queueTimeoutMs = options.queueTimeoutMs ?? 30_000
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000
    this.forwardTimeoutMs = options.forwardTimeoutMs ?? 30_000
  }

  async open(request: SshTunnelRequest): Promise<Duplex> {
    if (this.closing) throw new SshTunnelError('SSH_TUNNEL_CLOSED')
    const key = this.poolKey(request.ssh)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let entry: PoolEntry | undefined
      let acquired = false
      try {
        entry = await this.getOrCreateEntry(key, request.ssh)
        await this.acquireChannel(entry)
        acquired = true
        const channel = await this.withForwardTimeout(entry.transport.forwardOut(request.target))
        channel.once('close', () => this.releaseChannel(entry as PoolEntry))
        return channel
      } catch (error) {
        if (acquired && entry) this.releaseChannel(entry)
        if (error instanceof SshTunnelError && error.code === 'SSH_TUNNEL_BUSY') throw error
        if (entry) this.evict(entry, true)
        if (attempt === 1) throw new SshTunnelError('SSH_TUNNEL_FAILED')
      }
    }

    throw new SshTunnelError('SSH_TUNNEL_FAILED')
  }

  async close(): Promise<void> {
    this.closing = true
    const pending = [...this.connecting.values()]
    for (const entry of this.entries.values()) this.evict(entry, true)
    await Promise.allSettled(pending)
    for (const entry of this.entries.values()) this.evict(entry, true)
  }

  private poolKey(options: SshTransportConnectOptions): string {
    const endpoint = normalizeSshEndpoint(options.host, options.port)
    const credential = createHmac('sha256', this.credentialKey)
      .update(options.password)
      .digest('base64url')
    return `${endpoint}\u0000${options.username}\u0000${credential}`
  }

  private async getOrCreateEntry(
    key: string,
    options: SshTransportConnectOptions,
  ): Promise<PoolEntry> {
    const existing = this.entries.get(key)
    if (existing && !existing.closed) return existing
    const pending = this.connecting.get(key)
    if (pending) return pending

    const connection = this.createEntry(key, options)
    this.connecting.set(key, connection)
    try {
      return await connection
    } finally {
      if (this.connecting.get(key) === connection) this.connecting.delete(key)
    }
  }

  private async createEntry(
    key: string,
    options: SshTransportConnectOptions,
  ): Promise<PoolEntry> {
    const transport = await this.factory.connect(options)
    if (this.closing) {
      transport.close()
      throw new SshTunnelError('SSH_TUNNEL_CLOSED')
    }
    const entry: PoolEntry = {
      key,
      transport,
      activeChannels: 0,
      waiters: [],
      idleTimer: undefined,
      closed: false,
      unsubscribe: () => undefined,
    }
    entry.unsubscribe = transport.onClose(() => this.evict(entry, false))
    this.entries.set(key, entry)
    return entry
  }

  private async acquireChannel(entry: PoolEntry): Promise<void> {
    if (entry.closed) throw new SshTunnelError('SSH_TUNNEL_FAILED')
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    if (entry.activeChannels < this.maxChannels) {
      entry.activeChannels += 1
      return
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: WaitingChannel = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = entry.waiters.indexOf(waiter)
          if (index >= 0) entry.waiters.splice(index, 1)
          reject(new SshTunnelError('SSH_TUNNEL_BUSY'))
        }, this.queueTimeoutMs),
      }
      waiter.timer.unref?.()
      entry.waiters.push(waiter)
    })
  }

  private releaseChannel(entry: PoolEntry): void {
    if (entry.closed) return
    entry.activeChannels = Math.max(0, entry.activeChannels - 1)
    const waiter = entry.waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      entry.activeChannels += 1
      waiter.resolve()
      return
    }
    if (entry.activeChannels === 0) this.scheduleIdleClose(entry)
  }

  private scheduleIdleClose(entry: PoolEntry): void {
    if (entry.idleTimer || entry.closed) return
    entry.idleTimer = setTimeout(() => this.evict(entry, true), this.idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  private evict(entry: PoolEntry, closeTransport: boolean): void {
    if (entry.closed) return
    entry.closed = true
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.unsubscribe()
    for (const waiter of entry.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new SshTunnelError('SSH_TUNNEL_FAILED'))
    }
    if (closeTransport) entry.transport.close()
  }

  private async withForwardTimeout(channel: Promise<Duplex>): Promise<Duplex> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        channel,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new SshTunnelError('SSH_TUNNEL_FAILED')),
            this.forwardTimeoutMs,
          )
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
