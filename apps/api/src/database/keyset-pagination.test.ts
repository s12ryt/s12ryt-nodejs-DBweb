import { describe, expect, it } from 'vitest'

import {
  KeysetPaginationError,
  buildKeysetPredicate,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from './keyset-pagination.js'

describe('keyset pagination', () => {
  it('以不透明游標保留複合穩定鍵與方向', () => {
    const cursor = encodeKeysetCursor({
      key: ['tenant_id', 'id'],
      values: ['acme', 42],
      direction: 'forward',
    })

    expect(cursor).not.toContain('tenant_id')
    expect(decodeKeysetCursor(cursor, ['tenant_id', 'id'])).toEqual({
      key: ['tenant_id', 'id'],
      values: ['acme', 42],
      direction: 'forward',
    })
  })

  it('建立全參數化的字典序前進與後退條件', () => {
    expect(buildKeysetPredicate('postgres', ['tenant_id', 'id'], ['acme', 42], 'forward')).toEqual({
      sql: '("tenant_id" > $1) OR ("tenant_id" = $2 AND "id" > $3)',
      values: ['acme', 'acme', 42],
      orderBy: '"tenant_id" ASC, "id" ASC',
      reverseResults: false,
    })
    expect(buildKeysetPredicate('mysql', ['tenant_id', 'id'], ['acme', 42], 'backward')).toEqual({
      sql: '(`tenant_id` < ?) OR (`tenant_id` = ? AND `id` < ?)',
      values: ['acme', 'acme', 42],
      orderBy: '`tenant_id` DESC, `id` DESC',
      reverseResults: true,
    })
  })

  it('拒絕欄位漂移、篡改及不可安全序列化的游標值', () => {
    const cursor = encodeKeysetCursor({ key: ['id'], values: [1], direction: 'forward' })

    expect(() => decodeKeysetCursor(cursor, ['other_id'])).toThrow(KeysetPaginationError)
    expect(() => decodeKeysetCursor(`${cursor}x`, ['id'])).toThrow(KeysetPaginationError)
    expect(() => encodeKeysetCursor({
      key: ['id'],
      values: [{ nested: true } as never],
      direction: 'forward',
    })).toThrow(KeysetPaginationError)
  })
})
