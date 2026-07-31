import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'
import type { ConnectConfig } from 'ssh2'

import {
  MemorySshHostKeyResetRecorder,
  MemorySshKnownHostRepository,
  SshKnownHostService,
} from './ssh-known-host-service.js'
import { SshTunnelError } from './ssh-tunnel-pool.js'
import { Ssh2TransportFactory, type Ssh2ClientLike } from './ssh2-transport-factory.js'

class FakeSsh2Client extends EventEmitter implements Ssh2ClientLike {
  readonly end = vi.fn()
  readonly forwardOut = vi.fn()
  config?: ConnectConfig

  connect(config: ConnectConfig): this {
    this.config = config
    return this
  }
}

function createFactory(client: FakeSsh2Client) {
  const knownHosts = new SshKnownHostService(
    new MemorySshKnownHostRepository(),
    new MemorySshHostKeyResetRecorder(),
  )
  return new Ssh2TransportFactory(knownHosts, () => client)
}

describe('Ssh2TransportFactory', () => {
  it('以密碼、30 秒 timeout 與 SHA-256 TOFU 完成握手', async () => {
    const client = new FakeSsh2Client()
    const factory = createFactory(client)
    const connected = factory.connect({
      host: 'SSH.INTERNAL',
      port: 2222,
      username: 'operator',
      password: 'secret',
    })
    const verifier = client.config?.hostVerifier
    expect(client.config).toMatchObject({
      host: 'SSH.INTERNAL',
      port: 2222,
      username: 'operator',
      password: 'secret',
      hostHash: 'sha256',
      readyTimeout: 30_000,
    })
    expect(verifier).toBeTypeOf('function')

    const verified = new Promise<boolean>((resolve) => {
      ;(verifier as (key: string, callback: (accepted: boolean) => void) => void)(
        'sha256:first',
        resolve,
      )
    })
    await expect(verified).resolves.toBe(true)
    client.emit('ready')
    await expect(connected).resolves.toBeDefined()
  })

  it('forwardOut 保留遠端 DNS 目標並回傳 stream', async () => {
    const client = new FakeSsh2Client()
    const connected = createFactory(client).connect({
      host: 'ssh.internal',
      port: 22,
      username: 'operator',
      password: 'secret',
    })
    client.emit('ready')
    const transport = await connected
    const stream = new PassThrough()
    client.forwardOut.mockImplementationOnce(
      (_sourceHost, _sourcePort, _targetHost, _targetPort, callback) => callback(undefined, stream),
    )

    await expect(transport.forwardOut({ host: 'database.internal', port: 5432 })).resolves.toBe(stream)
    expect(client.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'database.internal',
      5432,
      expect.any(Function),
    )
  })

  it('握手錯誤會清理 client 並只回傳安全錯誤', async () => {
    const client = new FakeSsh2Client()
    const connected = createFactory(client).connect({
      host: 'ssh.internal',
      port: 22,
      username: 'operator',
      password: 'secret',
    })
    client.emit('error', new Error('private authentication details'))

    await expect(connected).rejects.toEqual(new SshTunnelError('SSH_TUNNEL_FAILED'))
    expect(client.end).toHaveBeenCalledOnce()
  })
})
