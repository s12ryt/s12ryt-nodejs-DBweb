import { describe, expect, it } from 'vitest'

import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import {
  TransferMappingError,
  applyTransferMapping,
  buildTransferColumnMapping,
  type TransferSourceColumn,
  type TransferTargetColumn,
} from './transfer-column-mapping.js'

const source: TransferSourceColumn[] = [
  { name: 'external_id', type: 'bigint' },
  { name: 'display_name', type: 'string' },
  { name: 'obsolete', type: 'string' },
]

const target: TransferTargetColumn[] = [
  { name: 'id', type: 'bigint', nullable: false, generated: false, hasDefault: false },
  { name: 'display_name', type: 'string', nullable: false, generated: false, hasDefault: false },
  { name: 'note', type: 'string', nullable: true, generated: false, hasDefault: false },
  { name: 'created_at', type: 'datetime', nullable: false, generated: false, hasDefault: true },
  { name: 'generated_code', type: 'string', nullable: false, generated: true, hasDefault: true },
]

describe('transfer column mapping', () => {
  it('combines explicit mapping, automatic name mapping, ignored extras, NULL, and DEFAULT', () => {
    const plan = buildTransferColumnMapping(source, target, [{
      source: 'external_id', target: 'id',
    }, { source: 'obsolete', ignore: true }])

    expect(plan).toEqual({
      mapped: [
        { source: 'external_id', target: 'id', type: 'bigint' },
        { source: 'display_name', target: 'display_name', type: 'string' },
      ],
      missing: [
        { target: 'note', value: { kind: 'null' } },
        { target: 'created_at', value: { kind: 'default' } },
      ],
      ignored: ['obsolete'],
    })

    const row: Record<string, TaggedDatabaseValue> = {
      external_id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
      display_name: { kind: 'value', type: 'string', value: '' },
      obsolete: { kind: 'value', type: 'string', value: 'discarded' },
    }
    expect(applyTransferMapping(row, plan)).toEqual({
      id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
      display_name: { kind: 'value', type: 'string', value: '' },
      note: { kind: 'null' },
      created_at: { kind: 'default' },
    })
  })

  it('automatically maps exact names and excludes generated target columns', () => {
    const plan = buildTransferColumnMapping(
      [{ name: 'display_name', type: 'string' }],
      target.filter((column) => column.name !== 'id'),
      [],
    )
    expect(plan.mapped).toEqual([
      { source: 'display_name', target: 'display_name', type: 'string' },
    ])
    expect(plan.missing.map((value) => value.target)).toEqual(['note', 'created_at'])
  })

  it('rejects silent source drops, missing required targets, duplicate targets, and incompatible types', () => {
    const cases = [
      () => buildTransferColumnMapping(source, target, [{ source: 'external_id', target: 'id' }]),
      () => buildTransferColumnMapping(
        [{ name: 'external_id', type: 'bigint' }],
        target,
        [{ source: 'external_id', target: 'id' }],
      ),
      () => buildTransferColumnMapping(source, target, [
        { source: 'external_id', target: 'id' },
        { source: 'display_name', target: 'id' },
        { source: 'obsolete', ignore: true },
      ]),
      () => buildTransferColumnMapping(source, target, [
        { source: 'external_id', target: 'display_name' },
        { source: 'display_name', ignore: true },
        { source: 'obsolete', ignore: true },
      ]),
    ]
    for (const run of cases) expect(run).toThrow(TransferMappingError)
  })

  it('rejects rows with missing, extra, or mismatched source values', () => {
    const plan = buildTransferColumnMapping(source, target, [
      { source: 'external_id', target: 'id' },
      { source: 'obsolete', ignore: true },
    ])
    expect(() => applyTransferMapping({
      external_id: { kind: 'value', type: 'bigint', value: '1' },
      display_name: { kind: 'value', type: 'string', value: 'name' },
    }, plan)).toThrow(TransferMappingError)
    expect(() => applyTransferMapping({
      external_id: { kind: 'value', type: 'string', value: '1' },
      display_name: { kind: 'value', type: 'string', value: 'name' },
      obsolete: { kind: 'value', type: 'string', value: 'x' },
      extra: { kind: 'null' },
    }, plan)).toThrow(TransferMappingError)
  })
})
