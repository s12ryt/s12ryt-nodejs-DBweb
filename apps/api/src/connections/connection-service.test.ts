import { describe, expect, it, vi } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  ConnectionError,
  ConnectionService,
  type DatabaseConnector,
} from './connection-service.js'
import { MemoryConnectionRepository } from './memory-connection-repository.js'

const baseInput = {
  name: 'Production reporting',
  engine: 'postgres' as const,
  host: 'db.example.test',
  port: 5432,
  database: 'reporting',
  username: 'reader',
  password: 'database-secret',
  tls: {
    mode: 'verify-full' as const,
    ca: 'CA PEM',
    certificate: 'CLIENT CERT PEM',
    privateKey: 'CLIENT KEY PEM',
  },
  keepAlive: { enabled: true, intervalMs: 300_000 },
}

function setup(connector?: DatabaseConnector) {
  const repository = new MemoryConnectionRepository()
  const encryption = new EnvelopeEncryption(Buffer.alloc(32, 3))
  const defaultConnector: DatabaseConnector = connector ?? {
    test: vi.fn(async () => ({ latencyMs: 12, serverVersion: '16.3' })),
  }
  const service = new ConnectionService(repository, encryption, {
    postgres: defaultConnector,
    mysql: defaultConnector,
  })
  return { repository, service, connector: defaultConnector }
}

describe('ConnectionService', () => {
  it('只回傳公開連線資料，密碼與 TLS 金鑰以用途綁定密文保存', async () => {
    const { repository, service } = setup()

    const profile = await service.create(baseInput, 'admin-id')

    expect(profile).toMatchObject({
      name: baseInput.name,
      engine: 'postgres',
      tls: { mode: 'verify-full', hasCa: true, hasClientCertificate: true },
    })
    expect(profile).not.toHaveProperty('password')
    const stored = repository.getStored(profile.id)
    expect(stored?.encryptedSecrets).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toContain('database-secret')
    expect(JSON.stringify(stored)).not.toContain('CLIENT KEY PEM')
  })

  it.each([59_999, 86_400_001])('拒絕超出 1 分鐘到 24 小時範圍的保活間隔：%i', async (intervalMs) => {
    const { service } = setup()

    await expect(
      service.create({ ...baseInput, keepAlive: { enabled: true, intervalMs } }, 'admin-id'),
    ).rejects.toEqual(new ConnectionError('INVALID_KEEPALIVE_INTERVAL'))
  })

  it('停用保活時忽略間隔並正規化為預設五分鐘', async () => {
    const { service } = setup()

    const profile = await service.create(
      { ...baseInput, keepAlive: { enabled: false, intervalMs: 1 } },
      'admin-id',
    )

    expect(profile.keepAlive).toEqual({ enabled: false, intervalMs: 300_000 })
  })

  it('連線測試解密完整 TLS 設定交給正確 driver，但結果不包含 secret', async () => {
    const test = vi.fn(async () => ({ latencyMs: 8, serverVersion: 'PostgreSQL 9.6.24' }))
    const { service } = setup({ test })
    const profile = await service.create(baseInput, 'admin-id')

    const result = await service.testConnection(profile.id)

    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({
        password: 'database-secret',
        tls: expect.objectContaining({
          mode: 'verify-full',
          ca: 'CA PEM',
          certificate: 'CLIENT CERT PEM',
          privateKey: 'CLIENT KEY PEM',
        }),
      }),
    )
    expect(result).toEqual({ latencyMs: 8, serverVersion: 'PostgreSQL 9.6.24' })
    expect(JSON.stringify(result)).not.toContain('database-secret')
  })

  it('SSH 密碼只存在用途綁定密文，公開資料不含密碼，解析後交給 driver', async () => {
    const test = vi.fn(async () => ({ latencyMs: 9, serverVersion: '16.3' }))
    const { repository, service } = setup({ test })
    const profile = await service.create({
      ...baseInput,
      ssh: {
        enabled: true,
        host: 'ssh.example.test',
        port: 2222,
        username: 'tunnel-user',
        password: 'ssh-password',
      },
    }, 'admin-id')

    expect(profile).toMatchObject({
      ssh: {
        enabled: true,
        host: 'ssh.example.test',
        port: 2222,
        username: 'tunnel-user',
      },
    })
    expect(JSON.stringify(profile)).not.toContain('ssh-password')
    expect(JSON.stringify(repository.getStored(profile.id))).not.toContain('ssh-password')

    await service.testConnection(profile.id)
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      ssh: {
        enabled: true,
        host: 'ssh.example.test',
        port: 2222,
        username: 'tunnel-user',
        password: 'ssh-password',
      },
    }))
  })

  it.each([
    { host: '', port: 22, username: 'user', password: 'secret' },
    { host: 'ssh.internal', port: 0, username: 'user', password: 'secret' },
    { host: 'ssh.internal', port: 65_536, username: 'user', password: 'secret' },
    { host: 'ssh.internal', port: 22, username: '', password: 'secret' },
    { host: 'ssh.internal', port: 22, username: 'user', password: '' },
  ])('拒絕不完整或無效的 SSH 設定：$host:$port', async (ssh) => {
    const { service } = setup()

    await expect(service.create({
      ...baseInput,
      ssh: { enabled: true as const, ...ssh },
    }, 'admin-id')).rejects.toEqual(new ConnectionError('INVALID_SSH_CONFIGURATION'))
  })

  it('未知連線回傳明確錯誤', async () => {
    const { service } = setup()

    await expect(service.testConnection('missing')).rejects.toEqual(
      new ConnectionError('CONNECTION_NOT_FOUND'),
    )
  })
})
