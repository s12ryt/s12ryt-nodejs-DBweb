import { Duplex } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from './connection-types.js'
import { TunnelDatabaseSocketProvider } from './database-socket-provider.js'

const directConnection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Main',
  engine: 'postgres',
  host: 'database.internal',
  port: 5432,
  database: 'app',
  username: 'reader',
  password: 'database-secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

describe('TunnelDatabaseSocketProvider', () => {
  it('直連設定不建立 SSH channel', async () => {
    const pool = { open: vi.fn() }
    const provider = new TunnelDatabaseSocketProvider(pool)

    await expect(provider.open(directConnection)).resolves.toBeUndefined()
    expect(pool.open).not.toHaveBeenCalled()
  })

  it('SSH 設定以 SSH 端解析的資料庫 host 與 port 開啟 channel', async () => {
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const pool = { open: vi.fn(async () => channel) }
    const provider = new TunnelDatabaseSocketProvider(pool)

    await expect(provider.open({
      ...directConnection,
      ssh: {
        enabled: true,
        host: 'bastion.example.test',
        port: 2222,
        username: 'deploy',
        password: 'ssh-secret',
      },
    })).resolves.toBe(channel)

    expect(pool.open).toHaveBeenCalledWith({
      ssh: {
        host: 'bastion.example.test',
        port: 2222,
        username: 'deploy',
        password: 'ssh-secret',
      },
      target: { host: 'database.internal', port: 5432 },
    })
  })
})
