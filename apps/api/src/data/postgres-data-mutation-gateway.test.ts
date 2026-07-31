import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { DataMutationError } from './data-mutation-service.js'
import { PostgresDataMutationGateway } from './postgres-data-mutation-gateway.js'

const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Main',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'app',
  username: 'writer',
  password: 'secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
}

describe('PostgresDataMutationGateway', () => {
  it('讀取相容 PostgreSQL 9.6 的欄位與唯一鍵 metadata', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [
        { column_name: 'id', type_name: 'int8', type_category: 'N', nullable: false, default_expression: "nextval('orders_id_seq'::regclass)" },
        { column_name: 'email', type_name: 'text', type_category: 'S', nullable: false, default_expression: "'unknown'::text" },
        { column_name: 'payload', type_name: 'jsonb', type_category: 'U', nullable: true, default_expression: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        { key_name: 'orders_pkey', primary_key: true, columns: '{id}' },
        { key_name: 'orders_email_key', primary_key: false, columns: '{email}' },
      ] })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDataMutationGateway(() => client)

    await expect(gateway.describeTable(connection, 'odd"schema', 'orders')).resolves.toEqual({
      schema: 'odd"schema',
      name: 'orders',
      columns: [
        { name: 'id', valueType: 'bigint', nullable: false, generated: true, hasDefault: true },
        { name: 'email', valueType: 'string', nullable: false, generated: false, hasDefault: true },
        { name: 'payload', valueType: 'json', nullable: true, generated: false, hasDefault: false },
      ],
      uniqueKeys: [
        { name: 'orders_pkey', kind: 'primary', columns: ['id'] },
        { name: 'orders_email_key', kind: 'unique', columns: ['email'] },
      ],
    })
    expect(query.mock.calls[0]?.[1]).toEqual(['odd"schema', 'orders'])
    expect(query.mock.calls[1]?.[0]).toContain('array_agg(a.attname::text')
    expect(query.mock.calls[1]?.[1]).toEqual(['odd"schema', 'orders'])
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('在同一交易執行參數化新增、更新與已確認刪除', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: '7' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDataMutationGateway(() => client)

    await expect(gateway.executeTransaction(connection, {
      schema: 'odd"schema',
      table: 'orders',
      metadata: {
        schema: 'odd"schema',
        name: 'orders',
        columns: [
          { name: 'id', valueType: 'bigint', nullable: false, generated: true },
          { name: 'email', valueType: 'string', nullable: false, generated: false },
          { name: 'payload', valueType: 'json', nullable: true, generated: false },
        ],
        uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
      },
      operations: [
        { kind: 'insert', values: {
          email: { kind: 'value', type: 'string', value: 'new@example.test' },
          payload: { kind: 'default' },
        } },
        {
          kind: 'update',
          identity: { id: { kind: 'value', type: 'bigint', value: '7' } },
          original: {
            id: { kind: 'value', type: 'bigint', value: '7' },
            email: { kind: 'value', type: 'string', value: 'old@example.test' },
            payload: { kind: 'null' },
          },
          patch: { email: { kind: 'value', type: 'string', value: 'new@example.test' } },
        },
        {
          kind: 'delete',
          confirmed: true,
          identity: { id: { kind: 'value', type: 'bigint', value: '8' } },
          original: {
            id: { kind: 'value', type: 'bigint', value: '8' },
            email: { kind: 'value', type: 'string', value: 'gone@example.test' },
            payload: { kind: 'null' },
          },
        },
      ],
    })).resolves.toEqual({
      affectedRows: 3,
      items: [
        { index: 0, affectedRows: 1, insertId: '7' },
        { index: 1, affectedRows: 1 },
        { index: 2, affectedRows: 1 },
      ],
    })

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO "odd""schema"."orders"')
    expect(query.mock.calls[1]?.[0]).toContain('VALUES ($1, DEFAULT)')
    expect(query.mock.calls[2]?.[0]).toContain('"payload" IS NULL')
    expect(query.mock.calls[2]?.[1]).toEqual([
      'new@example.test', 7n, 7n, 'old@example.test',
    ])
    expect(query).toHaveBeenLastCalledWith('COMMIT')
  })

  it('樂觀鎖未命中時 rollback 整筆交易並回衝突', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
    const client = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresDataMutationGateway(() => client)

    await expect(gateway.executeTransaction(connection, {
      schema: 'public',
      table: 'orders',
      metadata: {
        schema: 'public',
        name: 'orders',
        columns: [
          { name: 'id', valueType: 'bigint', nullable: false, generated: true },
          { name: 'email', valueType: 'string', nullable: false, generated: false },
        ],
        uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
      },
      operations: [{
        kind: 'update',
        identity: { id: { kind: 'value', type: 'bigint', value: '1' } },
        original: { id: { kind: 'value', type: 'bigint', value: '1' } },
        patch: { email: { kind: 'value', type: 'string', value: 'changed@example.test' } },
      }],
    })).rejects.toMatchObject(new DataMutationError('ROW_CONFLICT', 0))
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.end).toHaveBeenCalledOnce()
  })
})
