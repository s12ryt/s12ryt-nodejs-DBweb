import { describe, expect, it } from 'vitest'

import { buildSqlDumpTableObjects } from './sql-dump-table-objects.js'

describe('SQL dump table objects', () => {
  it('builds deterministic table, constraint, index, and data dependencies', () => {
    const result = buildSqlDumpTableObjects({
      schema: 'public',
      name: 'orders',
      columns: [
        { name: 'id', type: { name: 'bigint' }, nullable: false, identity: true },
        { name: 'customer_id', type: { name: 'bigint' }, nullable: false },
        { name: 'code', type: { name: 'varchar', length: 32 }, nullable: false },
      ],
      primaryKey: ['id'],
      constraints: [
        { name: 'orders_code_key', constraint: { kind: 'unique', columns: ['code'] } },
        {
          name: 'orders_customer_fk',
          constraint: {
            kind: 'foreign-key', columns: ['customer_id'], referenceSchema: 'public',
            referenceTable: 'customers', referenceColumns: ['id'], onDelete: 'cascade',
          },
        },
      ],
      indexes: [{
        name: 'orders_code_idx', method: 'btree', unique: false,
        parts: [{ column: 'code', order: 'asc' }],
      }],
    }, true)

    expect(result.map((object) => object.id)).toEqual([
      'table:public.orders',
      'constraint:public.orders.orders_code_key',
      'constraint:public.orders.orders_customer_fk',
      'index:public.orders.orders_code_idx',
    ])
    expect(result[0]).toEqual(expect.objectContaining({
      dependencies: [],
      dataEntry: 'data/public.orders.ndjson',
      createCommands: [expect.objectContaining({ kind: 'create-table', primaryKey: ['id'] })],
    }))
    expect(result[2]?.dependencies).toEqual(['table:public.orders', 'table:public.customers'])
    expect(result[3]?.dependencies).toEqual(['table:public.orders'])
  })

  it('omits data entries and rejects duplicate object names', () => {
    const table = {
      schema: 'public', name: 'items', columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
      constraints: [
        { name: 'duplicate', constraint: { kind: 'unique' as const, columns: ['id'] } },
        { name: 'duplicate', constraint: { kind: 'check' as const, expression: 'id > 0' } },
      ],
      indexes: [],
    }
    expect(buildSqlDumpTableObjects({ ...table, constraints: [] }, false)[0]?.dataEntry).toBeUndefined()
    expect(() => buildSqlDumpTableObjects(table, true)).toThrow('INVALID_SQL_DUMP_TABLE')
  })
})
