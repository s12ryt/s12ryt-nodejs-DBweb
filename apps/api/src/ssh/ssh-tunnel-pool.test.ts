import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SshTunnelError,
  SshTunnelPool,
  type SshTransport,
} from './ssh-tunnel-pool.js'

class FakeTransport implements SshTransport {
  readonly close = vi.fn(() => this.events.emit('close'))
  readonly forwardOut = vi.fn(async () => new PassThrough())
  private readonly events = new EventEmitter()

  onClose(listener: () => void): () => void {
    this.events.on('close', listener)
    return () => this.events.off('close', listener)
  }
}

const request = (password = 'secret') => ({
  ssh: { host: 'SSH.INTERNAL', port: 22, username: 'operator', password },
  target: { host: 'database.internal', port: 5432 },
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SshTunnelPool', () => {
  it('同 endpoint、username 與密碼共享 transport，不同密碼隔離', async () => {
    const transports: FakeTransport[] = []
    const factory = {
      connect: vi.fn(async () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      }),
    }
    const pool = new SshTunnelPool(factory, Buffer.alloc(32, 1))

    const first = await pool.open(request())
    const second = await pool.open(request())
    const otherCredential = await pool.open(request('other-secret'))

    expect(factory.connect).toHaveBeenCalledTimes(2)
    expect(transports[0]?.forwardOut).toHaveBeenCalledTimes(2)
    first.destroy()
    second.destroy()
    otherCredential.destroy()
    await pool.close()
  })

  it('達 channel 上限時排隊，釋放後取得 channel，逾時則回安全錯誤', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const pool = new SshTunnelPool(
      { connect: vi.fn(async () => transport) },
      Buffer.alloc(32, 2),
      { maxChannels: 1, queueTimeoutMs: 30_000 },
    )
    const first = await pool.open(request())
    const queued = pool.open(request())
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.forwardOut).toHaveBeenCalledTimes(1)

    first.destroy()
    await expect(queued).resolves.toBeInstanceOf(PassThrough)

    const timedOut = pool.open(request())
    const timedOutExpectation = expect(timedOut).rejects.toEqual(
      new SshTunnelError('SSH_TUNNEL_BUSY'),
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await timedOutExpectation
    await pool.close()
  })

  it('forward channel 失敗時淘汰 transport 並只自動重連一次', async () => {
    const first = new FakeTransport()
    first.forwardOut.mockRejectedValueOnce(new Error('socket details must not escape'))
    const second = new FakeTransport()
    const factory = {
      connect: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    }
    const pool = new SshTunnelPool(factory, Buffer.alloc(32, 3))

    const channel = await pool.open(request())

    expect(factory.connect).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.forwardOut).toHaveBeenCalledOnce()
    channel.destroy()
    await pool.close()
  })

  it('閒置五分鐘關閉 transport，pool close 會立即關閉所有 transport', async () => {
    vi.useFakeTimers()
    const transports = [new FakeTransport(), new FakeTransport()]
    const factory = { connect: vi.fn()
      .mockResolvedValueOnce(transports[0])
      .mockResolvedValueOnce(transports[1]) }
    const pool = new SshTunnelPool(factory, Buffer.alloc(32, 4), { idleTimeoutMs: 300_000 })
    const first = await pool.open(request())
    const second = await pool.open(request('second'))
    first.destroy()

    await vi.advanceTimersByTimeAsync(299_999)
    expect(transports[0]?.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(transports[0]?.close).toHaveBeenCalledOnce()
    expect(transports[1]?.close).not.toHaveBeenCalled()

    await pool.close()
    expect(transports[1]?.close).toHaveBeenCalledOnce()
    second.destroy()
  })
})
