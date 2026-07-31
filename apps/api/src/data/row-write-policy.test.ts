import { describe, expect, it } from 'vitest'

import {
  RowWritePolicyError,
  buildRowWritePolicy,
  type MutationTable,
} from './row-write-policy.js'

const table: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: true },
    { name: 'tenant_id', valueType: 'string', nullable: false, generated: false },
    { name: 'external_id', valueType: 'string', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
    { name: 'opaque', valueType: 'unsupported', nullable: true, generated: false },
  ],
  uniqueKeys: [
    { name: 'orders_pkey', kind: 'primary', columns: ['id'] },
    { name: 'orders_external_key', kind: 'unique', columns: ['tenant_id', 'external_id'] },
  ],
}

describe('row write policy', () => {
  it('優先使用主鍵，並只開放非 generated 且已知型別欄位', () => {
    const policy = buildRowWritePolicy(table)

    expect(policy.identity).toEqual({
      name: 'orders_pkey',
      kind: 'primary',
      columns: ['id'],
    })
    expect(policy.writableColumns).toEqual(['tenant_id', 'external_id', 'note'])
    expect(policy.readOnlyColumns).toEqual(['id', 'opaque'])
  })

  it('沒有主鍵時只採用所有欄位皆 NOT NULL 的唯一鍵', () => {
    const policy = buildRowWritePolicy({
      ...table,
      uniqueKeys: [
        { name: 'nullable_note_key', kind: 'unique', columns: ['note'] },
        { name: 'external_key', kind: 'unique', columns: ['tenant_id', 'external_id'] },
      ],
    })

    expect(policy.identity?.name).toBe('external_key')
  })

  it('沒有穩定唯一鍵時標記資料表唯讀', () => {
    const policy = buildRowWritePolicy({
      ...table,
      uniqueKeys: [{ name: 'nullable_note_key', kind: 'unique', columns: ['note'] }],
    })

    expect(policy.identity).toBeNull()
    expect(policy.canUpdate).toBe(false)
    expect(policy.canDelete).toBe(false)
    expect(() => policy.assertMutableRow()).toThrow(
      new RowWritePolicyError('TABLE_WITHOUT_STABLE_KEY'),
    )
  })
})
