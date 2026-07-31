import { describe, expect, it } from 'vitest'

import type { MutationTable } from '../data/row-write-policy.js'
import {
  TransferFilterError,
  buildMysqlTransferFilter,
  buildPostgresTransferFilter,
  type TransferFilter,
} from './transfer-filter.js'

const table: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: false },
    { name: 'status', valueType: 'string', nullable: false, generated: false },
    { name: 'amount', valueType: 'decimal', nullable: true, generated: false },
    { name: 'opaque', valueType: 'unsupported', nullable: true, generated: false },
  ],
  uniqueKeys: [{ kind: 'primary', name: 'orders_pkey', columns: ['id'] }],
}

describe('transfer filters', () => {
  it('builds parameterized PostgreSQL filters with AND-only operators', () => {
    const filters: TransferFilter[] = [{
      column: 'status',
      operator: 'eq',
      value: { kind: 'value', type: 'string', value: "paid' OR true --" },
    }, {
      column: 'amount',
      operator: 'between',
      values: [
        { kind: 'value', type: 'decimal', value: '10.50' },
        { kind: 'value', type: 'decimal', value: '99.99' },
      ],
    }, { column: 'amount', operator: 'is-not-null' }]

    expect(buildPostgresTransferFilter(table, filters)).toEqual({
      sql: '"status" = $1 AND "amount" BETWEEN $2 AND $3 AND "amount" IS NOT NULL',
      values: ["paid' OR true --", '10.50', '99.99'],
    })
  })

  it('builds MySQL IN and LIKE filters without interpolating values', () => {
    expect(buildMysqlTransferFilter(table, [{
      column: 'id',
      operator: 'in',
      values: [
        { kind: 'value', type: 'bigint', value: '1' },
        { kind: 'value', type: 'bigint', value: '2' },
      ],
    }, {
      column: 'status',
      operator: 'like',
      value: { kind: 'value', type: 'string', value: '%paid_' },
    }])).toEqual({
      sql: '`id` IN (?, ?) AND `status` LIKE ?',
      values: [1n, 2n, '%paid_'],
    })
  })

  it('supports all comparison and null operators with an empty-filter identity', () => {
    expect(buildPostgresTransferFilter(table, [])).toEqual({ sql: '', values: [] })
    for (const operator of ['ne', 'lt', 'lte', 'gt', 'gte'] as const) {
      expect(buildPostgresTransferFilter(table, [{
        column: 'id', operator, value: { kind: 'value', type: 'bigint', value: '1' },
      }]).sql).toContain('$1')
    }
    expect(buildPostgresTransferFilter(table, [{ column: 'amount', operator: 'is-null' }]).sql)
      .toBe('"amount" IS NULL')
  })

  it('rejects unknown columns, unsupported types, wrong tagged types, and invalid arity', () => {
    const invalid: TransferFilter[][] = [
      [{ column: 'missing', operator: 'is-null' }],
      [{ column: 'opaque', operator: 'is-null' }],
      [{ column: 'id', operator: 'eq', value: { kind: 'value', type: 'string', value: '1' } }],
      [{ column: 'status', operator: 'eq', value: { kind: 'null' } }],
      [{ column: 'id', operator: 'between', values: [{ kind: 'value', type: 'bigint', value: '1' }] }],
      [{ column: 'id', operator: 'in', values: [] }],
      [{
        column: 'id',
        operator: 'in',
        values: Array.from({ length: 101 }, (_, index) => ({
          kind: 'value' as const,
          type: 'bigint' as const,
          value: String(index),
        })),
      }],
      [{ column: 'id', operator: 'like', value: { kind: 'value', type: 'bigint', value: '1' } }],
    ]

    for (const filters of invalid) {
      expect(() => buildPostgresTransferFilter(table, filters)).toThrow(TransferFilterError)
    }
  })
})
