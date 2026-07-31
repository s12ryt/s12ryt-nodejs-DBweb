import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  DataMutationError,
  DataMutationService,
  type DataMutationGateway,
  type MutationAuditRecorder,
} from './data-mutation-service.js'
import type { MutationTable } from './row-write-policy.js'

const table: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: true },
    { name: 'status', valueType: 'string', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
  ],
  uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
}

async function setup(tableMetadata: MutationTable = table) {
  const connector = { test: vi.fn(async () => ({ latencyMs: 1, serverVersion: '16' })) }
  const connections = new ConnectionService(
    new MemoryConnectionRepository(),
    new EnvelopeEncryption(Buffer.alloc(32, 5)),
    { postgres: connector, mysql: connector },
  )
  const profile = await connections.create(
    {
      name: 'Main',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      username: 'writer',
      password: 'secret',
      tls: { mode: 'disable' },
      keepAlive: { enabled: false },
    },
    'admin-1',
  )
  const gateway: DataMutationGateway = {
    describeTable: vi.fn(async () => tableMetadata),
    executeTransaction: vi.fn(async (
      _connection: Parameters<DataMutationGateway['executeTransaction']>[0],
      request: Parameters<DataMutationGateway['executeTransaction']>[1],
    ) => ({
      affectedRows: request.operations.length,
      items: request.operations.map((_, index) => ({ index, affectedRows: 1 })),
    })),
  }
  const audit: MutationAuditRecorder = { record: vi.fn(async () => undefined) }
  return {
    service: new DataMutationService(connections, { postgres: gateway, mysql: gateway }, audit),
    gateway,
    audit,
    profile,
  }
}

describe('DataMutationService', () => {
  it('回傳可寫欄位、唯讀欄位與穩定列鍵能力', async () => {
    const { service, profile } = await setup()

    await expect(service.inspect(
      { id: 'admin-1', role: 'admin' },
      { connectionId: profile.id, schema: 'public', table: 'orders' },
    )).resolves.toMatchObject({
      table,
      policy: {
        identity: { name: 'orders_pkey', columns: ['id'] },
        writableColumns: ['status', 'note'],
        readOnlyColumns: ['id'],
        canUpdate: true,
        canDelete: true,
      },
    })
  })

  it('只允許管理員寫入，並在解析連線前拒絕一般使用者', async () => {
    const { service, gateway, profile } = await setup()

    await expect(
      service.mutate(
        { id: 'user-1', role: 'user' },
        {
          connectionId: profile.id,
          schema: 'public',
          table: 'orders',
          operations: [{ kind: 'insert', values: { status: { kind: 'value', type: 'string', value: 'new' } } }],
        },
      ),
    ).rejects.toEqual(new DataMutationError('FORBIDDEN'))
    expect(gateway.describeTable).not.toHaveBeenCalled()
  })

  it('將最多 100 筆新增、個別更新與共用 patch 在一次交易中執行', async () => {
    const { service, gateway, profile, audit } = await setup()
    const identity = { id: { kind: 'value', type: 'bigint', value: '1' } } as const
    const original = {
      id: { kind: 'value', type: 'bigint', value: '1' },
      status: { kind: 'value', type: 'string', value: 'old' },
      note: { kind: 'null' },
    } as const

    await expect(
      service.mutate(
        { id: 'admin-1', role: 'admin' },
        {
          connectionId: profile.id,
          schema: 'public',
          table: 'orders',
          operations: [
            { kind: 'insert', values: { status: { kind: 'value', type: 'string', value: 'new' } } },
            {
              kind: 'update',
              identity,
              original,
              patch: { note: { kind: 'value', type: 'string', value: '' } },
            },
            {
              kind: 'batch-update',
              rows: [{ identity, original }],
              patch: { status: { kind: 'value', type: 'string', value: 'done' } },
            },
          ],
        },
      ),
    ).resolves.toMatchObject({ affectedRows: 3 })

    expect(gateway.executeTransaction).toHaveBeenCalledOnce()
    expect(gateway.executeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret' }),
      expect.objectContaining({ schema: 'public', table: 'orders' }),
    )
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        status: 'success',
        affectedRows: 3,
        sqlTemplates: [
          'INSERT INTO "public"."orders" ("status") VALUES ($1) RETURNING "id"',
          'UPDATE "public"."orders" SET "note" = $1 WHERE "id" = $2 AND "id" = $3 AND "status" = $4 AND "note" IS NULL',
          'UPDATE "public"."orders" SET "status" = $1 WHERE "id" = $2 AND "id" = $3 AND "status" = $4 AND "note" IS NULL',
        ],
      }),
    )
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls[0]?.[0])).not.toContain('old')
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls[0]?.[0])).not.toContain('new')
  })

  it('拒絕超過 100 列、generated 欄位、無完整原始列及未確認刪除', async () => {
    const { service, gateway, profile } = await setup()
    const identity = { id: { kind: 'value', type: 'bigint', value: '1' } } as const
    const validOriginal = {
      id: { kind: 'value', type: 'bigint', value: '1' },
      status: { kind: 'value', type: 'string', value: 'old' },
      note: { kind: 'null' },
    } as const
    const base = { connectionId: profile.id, schema: 'public', table: 'orders' }
    const invalidOperations = [
      Array.from({ length: 101 }, () => ({
        kind: 'insert' as const,
        values: { status: { kind: 'value' as const, type: 'string' as const, value: 'new' } },
      })),
      [{ kind: 'insert' as const, values: { id: { kind: 'value' as const, type: 'bigint' as const, value: '2' } } }],
      [{ kind: 'update' as const, identity, original: identity, patch: { status: { kind: 'value' as const, type: 'string' as const, value: 'new' } } }],
      [{ kind: 'delete' as const, identity, original: validOriginal }],
    ]

    for (const operations of invalidOperations) {
      await expect(
        service.mutate({ id: 'admin-1', role: 'admin' }, { ...base, operations }),
      ).rejects.toBeInstanceOf(DataMutationError)
    }
    expect(gateway.executeTransaction).not.toHaveBeenCalled()
  })

  it('無穩定唯一鍵時仍允許新增，但拒絕更新與刪除', async () => {
    const { service, gateway, profile } = await setup({ ...table, uniqueKeys: [] })
    const base = { connectionId: profile.id, schema: 'public', table: 'orders' }

    await expect(
      service.mutate(
        { id: 'admin-1', role: 'admin' },
        {
          ...base,
          operations: [{ kind: 'insert', values: { status: { kind: 'value', type: 'string', value: 'new' } } }],
        },
      ),
    ).resolves.toMatchObject({ affectedRows: 1 })

    await expect(
      service.mutate(
        { id: 'admin-1', role: 'admin' },
        {
          ...base,
          operations: [{
            kind: 'update',
            identity: { id: { kind: 'value', type: 'bigint', value: '1' } },
            original: {
              id: { kind: 'value', type: 'bigint', value: '1' },
              status: { kind: 'value', type: 'string', value: 'old' },
              note: { kind: 'null' },
            },
            patch: { status: { kind: 'value', type: 'string', value: 'new' } },
          }],
        },
      ),
    ).rejects.toEqual(new DataMutationError('TABLE_WITHOUT_STABLE_KEY'))
    expect(gateway.executeTransaction).toHaveBeenCalledOnce()
  })

  it('未知型別欄位保持唯讀，但不阻止以其餘已知欄位進行樂觀更新', async () => {
    const withOpaqueColumn: MutationTable = {
      ...table,
      columns: [
        ...table.columns,
        { name: 'vendor_value', valueType: 'unsupported', nullable: true, generated: false },
      ],
    }
    const { service, profile, gateway } = await setup(withOpaqueColumn)

    await expect(service.mutate(
      { id: 'admin-1', role: 'admin' },
      {
        connectionId: profile.id,
        schema: 'public',
        table: 'orders',
        operations: [{
          kind: 'update',
          identity: { id: { kind: 'value', type: 'bigint', value: '1' } },
          original: {
            id: { kind: 'value', type: 'bigint', value: '1' },
            status: { kind: 'value', type: 'string', value: 'old' },
            note: { kind: 'null' },
          },
          patch: { status: { kind: 'value', type: 'string', value: 'new' } },
        }],
      },
    )).resolves.toMatchObject({ affectedRows: 1 })

    const request = vi.mocked(gateway.executeTransaction).mock.calls[0]?.[1]
    expect(request?.metadata.columns).toContainEqual(
      expect.objectContaining({ name: 'vendor_value', valueType: 'unsupported' }),
    )
  })
})
