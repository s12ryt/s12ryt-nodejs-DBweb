import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { DataMutationError } from './data-mutation-service.js'
import { MysqlDataMutationGateway } from './mysql-data-mutation-gateway.js'

const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Main',
  engine: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'app',
  username: 'writer',
  password: 'secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
}

describe('MysqlDataMutationGateway', () => {
  it('讀取 MySQL 5.6 可用的欄位與唯一鍵 metadata', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{
        column_name: 'id', data_type: 'bigint', column_type: 'bigint(20)', is_nullable: 'NO', extra: 'auto_increment',
      }, {
        column_name: 'email', data_type: 'varchar', column_type: 'varchar(255)', is_nullable: 'NO', extra: '',
      }, {
        column_name: 'payload', data_type: 'json', column_type: 'json', is_nullable: 'YES', extra: '',
      }], []])
      .mockResolvedValueOnce([[
        { key_name: 'PRIMARY', non_unique: 0, column_name: 'id', sequence: 1 },
        { key_name: 'orders_email_key', non_unique: 0, column_name: 'email', sequence: 1 },
      ], []])
    const client = {
      query,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
    }
    const gateway = new MysqlDataMutationGateway(async () => client)

    await expect(gateway.describeTable(connection, 'app', 'orders')).resolves.toEqual({
      schema: 'app',
      name: 'orders',
      columns: [
        { name: 'id', valueType: 'bigint', nullable: false, generated: true },
        { name: 'email', valueType: 'string', nullable: false, generated: false },
        { name: 'payload', valueType: 'json', nullable: true, generated: false },
      ],
      uniqueKeys: [
        { name: 'PRIMARY', kind: 'primary', columns: ['id'] },
        { name: 'orders_email_key', kind: 'unique', columns: ['email'] },
      ],
    })
    expect(query.mock.calls[0]?.[1]).toEqual(['app', 'orders'])
    expect(query.mock.calls[1]?.[1]).toEqual(['app', 'orders'])
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('在同一交易執行參數化 mutation 並回傳 insert id', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 42 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }, []])
    const client = {
      query,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
    }
    const gateway = new MysqlDataMutationGateway(async () => client)

    await expect(gateway.executeTransaction(connection, {
      schema: 'odd`schema',
      table: 'orders',
      metadata: {
        schema: 'odd`schema',
        name: 'orders',
        columns: [
          { name: 'id', valueType: 'bigint', nullable: false, generated: true },
          { name: 'email', valueType: 'string', nullable: false, generated: false },
        ],
        uniqueKeys: [{ name: 'PRIMARY', kind: 'primary', columns: ['id'] }],
      },
      operations: [
        { kind: 'insert', values: {
          email: { kind: 'value', type: 'string', value: 'new@example.test' },
        } },
        {
          kind: 'update',
          identity: { id: { kind: 'value', type: 'bigint', value: '42' } },
          original: {
            id: { kind: 'value', type: 'bigint', value: '42' },
            email: { kind: 'value', type: 'string', value: 'old@example.test' },
          },
          patch: { email: { kind: 'value', type: 'string', value: '' } },
        },
      ],
    })).resolves.toEqual({
      affectedRows: 2,
      items: [
        { index: 0, affectedRows: 1, insertId: '42' },
        { index: 1, affectedRows: 1 },
      ],
    })

    expect(client.beginTransaction).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO `odd``schema`.`orders`')
    expect(query.mock.calls[1]?.[0]).toContain('`email` = ?')
    expect(query.mock.calls[1]?.[1]).toEqual(['', 42n, 42n, 'old@example.test'])
    expect(client.commit).toHaveBeenCalledOnce()
    expect(client.rollback).not.toHaveBeenCalled()
  })

  it('任一列衝突時 rollback 且不 commit', async () => {
    const client = {
      query: vi.fn(async () => [{ affectedRows: 0, insertId: 0 }, []] as [unknown, unknown]),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
    }
    const gateway = new MysqlDataMutationGateway(async () => client)

    await expect(gateway.executeTransaction(connection, {
      schema: 'app',
      table: 'orders',
      metadata: {
        schema: 'app',
        name: 'orders',
        columns: [{ name: 'id', valueType: 'bigint', nullable: false, generated: true }],
        uniqueKeys: [{ name: 'PRIMARY', kind: 'primary', columns: ['id'] }],
      },
      operations: [{
        kind: 'delete',
        confirmed: true,
        identity: { id: { kind: 'value', type: 'bigint', value: '1' } },
        original: { id: { kind: 'value', type: 'bigint', value: '1' } },
      }],
    })).rejects.toMatchObject(new DataMutationError('ROW_CONFLICT', 0))
    expect(client.rollback).toHaveBeenCalledOnce()
    expect(client.commit).not.toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledOnce()
  })
})
