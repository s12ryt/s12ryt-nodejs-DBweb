import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  DdlService,
  DdlServiceError,
  type DdlAuditRecorder,
  type DdlGateway,
} from './ddl-service.js'

async function setup(
  engine: 'postgres' | 'mysql' = 'postgres',
  authorize?: (actor: { id: string; role: 'admin' | 'user' }, connectionId: string) => Promise<boolean>,
) {
  const connector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: 'unused' })) }
  const connections = new ConnectionService(
    new MemoryConnectionRepository(),
    new EnvelopeEncryption(Buffer.alloc(32, 9)),
    { postgres: connector, mysql: connector },
  )
  const profile = await connections.create({
    name: 'Main', engine, host: 'localhost', port: engine === 'postgres' ? 5432 : 3306,
    database: 'app', username: 'admin', password: 'database-secret',
    tls: { mode: 'disable' }, keepAlive: { enabled: false },
  }, 'admin-1')
  const gateway: DdlGateway = {
    serverVersion: vi.fn(async () => engine === 'postgres' ? 'PostgreSQL 17.5' : '8.4.5'),
    execute: vi.fn(async () => undefined),
  }
  const audit: DdlAuditRecorder = { record: vi.fn(async () => undefined) }
  return {
    service: new DdlService(
      connections,
      { postgres: gateway, mysql: gateway },
      audit,
      undefined,
      authorize,
    ),
    profile,
    gateway,
    audit,
  }
}

describe('DdlService', () => {
  it('只允許管理員取得依真實版本偵測的能力矩陣', async () => {
    const { service, profile, gateway } = await setup()

    await expect(service.capabilities(
      { id: 'user-1', role: 'user' },
      profile.id,
    )).rejects.toEqual(new DdlServiceError('FORBIDDEN'))
    expect(gateway.serverVersion).not.toHaveBeenCalled()

    await expect(service.capabilities(
      { id: 'admin-1', role: 'admin' },
      profile.id,
    )).resolves.toMatchObject({
      engine: 'postgres',
      version: { major: 17, minor: 5, assumedMinimum: false },
      transactionalDdl: true,
    })
  })

  it('以交易執行PostgreSQL核心DDL並記錄不含連線密碼的稽核', async () => {
    const { service, profile, gateway, audit } = await setup()

    await expect(service.execute(
      { id: 'admin-1', role: 'admin' },
      {
        connectionId: profile.id,
        command: {
          kind: 'create-table', schema: 'public', name: 'orders',
          columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
        },
      },
    )).resolves.toEqual({ statementsExecuted: 1, transactional: true })

    expect(gateway.execute).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'database-secret' }),
      ['CREATE TABLE "public"."orders" ("id" bigint NOT NULL)'],
      { transactional: true },
    )
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1', connectionId: profile.id, objectType: 'table',
      objectName: 'public.orders', action: 'create-table', status: 'success',
      sqlTemplates: ['CREATE TABLE "public"."orders" ("id" bigint NOT NULL)'],
    }))
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls[0]?.[0])).not.toContain('database-secret')
  })

  it('注入的即時授權允許具ddl-write能力的一般使用者', async () => {
    const authorize = vi.fn(async () => true)
    const { service, profile, gateway } = await setup('postgres', authorize)

    await service.execute({ id: 'designer-1', role: 'user' }, {
      connectionId: profile.id,
      command: {
        kind: 'create-table', schema: 'public', name: 'reports',
        columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
      },
    })

    expect(authorize).toHaveBeenCalledWith(
      { id: 'designer-1', role: 'user' },
      profile.id,
    )
    expect(gateway.execute).toHaveBeenCalledOnce()
  })

  it('將PostgreSQL database DDL標示為非交易', async () => {
    const { service, profile, gateway } = await setup()

    await service.execute({ id: 'admin-1', role: 'admin' }, {
      connectionId: profile.id,
      command: { kind: 'create-database', name: 'analytics' },
    })

    expect(gateway.execute).toHaveBeenCalledWith(
      expect.anything(),
      ['CREATE DATABASE "analytics"'],
      { transactional: false },
    )
  })

  it('將driver失敗安全化並記錄失敗，不洩漏底層訊息', async () => {
    const { service, profile, gateway, audit } = await setup('mysql')
    vi.mocked(gateway.execute).mockRejectedValueOnce(new Error('database-secret at 10.0.0.4'))

    await expect(service.execute({ id: 'admin-1', role: 'admin' }, {
      connectionId: profile.id,
      command: { kind: 'rename-table', schema: 'app', from: 'orders', to: 'archived_orders' },
    })).rejects.toEqual(new DdlServiceError('DDL_FAILED'))
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', errorCode: 'DDL_FAILED', action: 'rename-table',
    }))
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain('database-secret at')
  })
})
