import { describe, expect, it } from 'vitest'

import {
  DEFAULT_VALUE,
  MutationValueError,
  decodeMutationValue,
  encodeDatabaseValue,
} from './tagged-value.js'

describe('tagged database values', () => {
  it('保留 bigint、decimal、時間、binary、JSON 與 array 的 wire 型別', () => {
    expect(encodeDatabaseValue(9_007_199_254_740_993n, 'bigint')).toEqual({
      kind: 'value',
      type: 'bigint',
      value: '9007199254740993',
    })
    expect(encodeDatabaseValue('1234567890.123456789', 'decimal')).toEqual({
      kind: 'value',
      type: 'decimal',
      value: '1234567890.123456789',
    })
    expect(encodeDatabaseValue('2026-07-31T10:15:00+08:00', 'timestamptz')).toEqual({
      kind: 'value',
      type: 'timestamptz',
      value: '2026-07-31T10:15:00+08:00',
    })
    expect(encodeDatabaseValue(Buffer.from([0, 255, 16]), 'binary')).toEqual({
      kind: 'value',
      type: 'binary',
      value: 'AP8Q',
    })
    expect(encodeDatabaseValue({ nested: ['value', 2] }, 'json')).toEqual({
      kind: 'value',
      type: 'json',
      value: { nested: ['value', 2] },
    })
    expect(encodeDatabaseValue(['one', 2, null], 'array')).toEqual({
      kind: 'value',
      type: 'array',
      value: ['one', 2, null],
    })
  })

  it('明確區分 NULL、DEFAULT、空字串與具體值', () => {
    expect(decodeMutationValue({ kind: 'null' })).toBeNull()
    expect(decodeMutationValue({ kind: 'default' })).toBe(DEFAULT_VALUE)
    expect(decodeMutationValue({ kind: 'value', type: 'string', value: '' })).toBe('')
    expect(
      decodeMutationValue({ kind: 'value', type: 'binary', value: 'AP8Q' }),
    ).toEqual(Buffer.from([0, 255, 16]))
    expect(
      decodeMutationValue({ kind: 'value', type: 'bigint', value: '9007199254740993' }),
    ).toBe(9_007_199_254_740_993n)
  })

  it('拒絕不合法標記值與未知 driver 型別，而不是猜測轉型', () => {
    expect(() => encodeDatabaseValue('opaque', 'vendor-specific')).toThrow(
      new MutationValueError('UNSUPPORTED_VALUE_TYPE'),
    )
    expect(() =>
      decodeMutationValue({ kind: 'value', type: 'bigint', value: '12.3' }),
    ).toThrow(new MutationValueError('INVALID_VALUE'))
    expect(() =>
      decodeMutationValue({ kind: 'value', type: 'binary', value: '%' }),
    ).toThrow(new MutationValueError('INVALID_VALUE'))
  })
})
