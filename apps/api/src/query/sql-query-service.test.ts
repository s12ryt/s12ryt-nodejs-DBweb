import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import {
  isReadOnlySql,
  QueryError,
  SqlQueryService,
  type QueryAuditRecorder,
  type SqlGateway,
} from './sql-query-service.js'

async function setup(gatewayOverrides: Partial<SqlGateway> = {}) {
  const connector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: '16' })) }
  const connections = new ConnectionService(
    new MemoryConnectionRepository(),
    new EnvelopeEncryption(Buffer.alloc(32, 4)),
    { postgres: connector, mysql: connector },
  )
  const profile = await connections.create(
    {
      name: 'Main',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      username: 'reader',
      password: 'secret',
      tls: { mode: 'disable' },
      keepAlive: { enabled: false },
    },
    'admin',
  )
  const gateway: SqlGateway = {
    execute: vi.fn(async () => ({ columns: ['id'], rows: [{ id: 1 }], affectedRows: 1 })),
    ...gatewayOverrides,
  }
  const audit: QueryAuditRecorder = { record: vi.fn(async () => undefined) }
  return {
    service: new SqlQueryService(connections, { postgres: gateway, mysql: gateway }, audit),
    profile,
    gateway,
    audit,
  }
}

describe('SqlQueryService', () => {
  it('支援多語句，預設 30 秒與 1000 列，並截斷額外結果列', async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id }))
    const { service, profile, gateway, audit } = await setup({
      execute: vi.fn(async () => ({ columns: ['id'], rows, affectedRows: 1001 })),
    })

    const result = await service.execute('user-1', {
      queryId: '11111111-1111-4111-8111-111111111111',
      connectionId: profile.id,
      sql: 'SELECT 1; SELECT 2;',
    })

    expect(gateway.execute).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret' }),
      expect.objectContaining({
        sql: 'SELECT 1; SELECT 2;',
        timeoutMs: 30_000,
        maxRows: 1001,
        signal: expect.any(AbortSignal),
      }),
    )
    expect(result.rows).toHaveLength(1000)
    expect(result.truncated).toBe(true)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it.each(['DROP TABLE users', '/* note */ DELETE FROM users', 'GRANT ALL ON users TO guest'])(
    '高風險 SQL 未確認時拒絕執行：%s',
    async (sql) => {
      const { service, profile, gateway } = await setup()
      await expect(
        service.execute('user-1', {
          queryId: '22222222-2222-4222-8222-222222222222',
          connectionId: profile.id,
          sql,
        }),
      ).rejects.toEqual(new QueryError('CONFIRMATION_REQUIRED'))
      expect(gateway.execute).not.toHaveBeenCalled()
    },
  )

  it('可取消本人執行中的查詢並記錄取消稽核', async () => {
    const execute = vi.fn(
      async (_connection, request) =>
        new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        }),
    )
    const { service, profile, audit } = await setup({ execute })
    const pending = service.execute('user-1', {
      queryId: '33333333-3333-4333-8333-333333333333',
      connectionId: profile.id,
      sql: 'SELECT pg_sleep(60)',
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

    await expect(service.cancel('user-1', '33333333-3333-4333-8333-333333333333')).resolves.toBe(true)
    await expect(pending).rejects.toEqual(new QueryError('QUERY_CANCELLED'))
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('拒絕空 SQL 與超出範圍的 timeout/row limit', async () => {
    const { service, profile } = await setup()
    for (const input of [
      { sql: ' ', timeoutMs: 30_000, rowLimit: 1000 },
      { sql: 'SELECT 1', timeoutMs: 0, rowLimit: 1000 },
      { sql: 'SELECT 1', timeoutMs: 30_000, rowLimit: 10_001 },
    ]) {
      await expect(
        service.execute('user-1', {
          queryId: '44444444-4444-4444-8444-444444444444',
          connectionId: profile.id,
          ...input,
        }),
      ).rejects.toEqual(new QueryError('INVALID_QUERY'))
    }
  })

  it('唯讀模式只接受單一讀取語句並要求gateway啟用唯讀交易', async () => {
    const { service, profile, gateway } = await setup()

    await service.execute('reader-1', {
      queryId: '55555555-5555-4555-8555-555555555555',
      connectionId: profile.id,
      sql: '/* report */ WITH source AS (SELECT 1 AS id) SELECT id FROM source;',
    }, { readOnly: true })

    expect(gateway.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ readOnly: true }),
    )
  })

  it.each([
    'SELECT 1; SELECT 2',
    'UPDATE accounts SET enabled = false',
    'WITH changed AS (DELETE FROM accounts RETURNING id) SELECT * FROM changed',
    'EXPLAIN ANALYZE DELETE FROM accounts',
    'SELECT * FROM accounts FOR UPDATE',
  ])('唯讀模式在連線前拒絕多語句、寫入或鎖定SQL：%s', async (sql) => {
    const { service, profile, gateway } = await setup()

    await expect(service.execute('reader-1', {
      queryId: '66666666-6666-4666-8666-666666666666',
      connectionId: profile.id,
      sql,
    }, { readOnly: true })).rejects.toEqual(new QueryError('READ_ONLY_QUERY_REQUIRED'))
    expect(gateway.execute).not.toHaveBeenCalled()
  })

  it('唯讀分類忽略字串與註解中的關鍵字，但不接受未知語句', () => {
    expect(isReadOnlySql("SELECT 'DELETE; UPDATE', 1 -- DROP\n")).toBe(true)
    expect(isReadOnlySql('SHOW TABLES')).toBe(true)
    expect(isReadOnlySql('CALL read_report()')).toBe(false)
  })

  it('保留可重試的資料庫操作忙碌錯誤', async () => {
    const busy = new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true)
    const { service, profile } = await setup({ execute: vi.fn(async () => { throw busy }) })

    await expect(service.execute('user-1', {
      queryId: '77777777-7777-4777-8777-777777777777',
      connectionId: profile.id,
      sql: 'SELECT 1',
    })).rejects.toBe(busy)
  })
})
