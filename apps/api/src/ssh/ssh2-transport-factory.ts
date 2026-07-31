import type { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'

import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'

import type { SshKnownHostService } from './ssh-known-host-service.js'
import {
  SshTunnelError,
  type SshForwardTarget,
  type SshTransport,
  type SshTransportConnectOptions,
  type SshTransportFactory,
} from './ssh-tunnel-pool.js'

type ForwardCallback = (error: Error | undefined, channel?: ClientChannel) => void

export interface Ssh2ClientLike {
  connect(config: ConnectConfig): unknown
  end(): unknown
  forwardOut(
    sourceHost: string,
    sourcePort: number,
    targetHost: string,
    targetPort: number,
    callback: ForwardCallback,
  ): unknown
  on: EventEmitter['on']
  once: EventEmitter['once']
  removeListener: EventEmitter['removeListener']
}

class Ssh2Transport implements SshTransport {
  constructor(private readonly client: Ssh2ClientLike) {}

  async forwardOut(target: SshForwardTarget): Promise<Duplex> {
    return new Promise<Duplex>((resolve, reject) => {
      this.client.forwardOut(
        '127.0.0.1',
        0,
        target.host,
        target.port,
        (error, channel) => {
          if (error || !channel) {
            reject(new SshTunnelError('SSH_TUNNEL_FAILED'))
            return
          }
          resolve(channel)
        },
      )
    })
  }

  close(): void {
    this.client.end()
  }

  onClose(listener: () => void): () => void {
    const closeListener = () => listener()
    const errorListener = () => listener()
    this.client.on('close', closeListener)
    this.client.on('error', errorListener)
    return () => {
      this.client.removeListener('close', closeListener)
      this.client.removeListener('error', errorListener)
    }
  }
}

export class Ssh2TransportFactory implements SshTransportFactory {
  constructor(
    private readonly knownHosts: SshKnownHostService,
    private readonly createClient: () => Ssh2ClientLike = () => new Client(),
  ) {}

  async connect(options: SshTransportConnectOptions): Promise<SshTransport> {
    const client = this.createClient()
    return new Promise<SshTransport>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        client.removeListener('ready', handleReady)
        client.removeListener('error', handleFailure)
        client.removeListener('close', handleFailure)
      }
      const handleFailure = () => {
        if (settled) return
        settled = true
        cleanup()
        client.end()
        reject(new SshTunnelError('SSH_TUNNEL_FAILED'))
      }
      const handleReady = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve(new Ssh2Transport(client))
      }
      const hostVerifier = ((fingerprint: string, verify: (accepted: boolean) => void) => {
        void this.knownHosts
          .verify(options.host, options.port, `sha256:${fingerprint.toLowerCase()}`)
          .then(() => verify(true), () => verify(false))
      }) as NonNullable<ConnectConfig['hostVerifier']>

      client.once('ready', handleReady)
      client.once('error', handleFailure)
      client.once('close', handleFailure)
      try {
        client.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          password: options.password,
          hostHash: 'sha256',
          hostVerifier,
          readyTimeout: 30_000,
        })
      } catch {
        handleFailure()
      }
    })
  }
}
