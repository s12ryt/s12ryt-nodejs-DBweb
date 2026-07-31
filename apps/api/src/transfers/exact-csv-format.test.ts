import { describe, expect, it } from 'vitest'

import {
  ExactCsvFormatError,
  decodeExactCsv,
  encodeExactCsv,
  type ExactCsvSidecar,
} from './exact-csv-format.js'
import type { TaggedDatabaseValue } from '../data/tagged-value.js'

const sidecar: ExactCsvSidecar = {
  format: 'dbweb-exact-csv',
  version: 1,
  schema: 'public',
  table: 'notes',
  delimiter: ',',
  bom: true,
  columns: [
    { name: 'id', type: 'bigint' },
    { name: 'body', type: 'string' },
    { name: 'nullable', type: 'string' },
  ],
}

const rows: Array<Record<string, TaggedDatabaseValue>> = [{
  id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
  body: { kind: 'value', type: 'string', value: 'comma, quote " and\nnewline' },
  nullable: { kind: 'null' },
}, {
  id: { kind: 'value', type: 'bigint', value: '2' },
  body: { kind: 'value', type: 'string', value: '' },
  nullable: { kind: 'default' },
}]

describe('exact CSV transfer format', () => {
  it('round trips tagged cells with BOM, quotes, embedded newlines, and split chunks', async () => {
    const encoded = Buffer.concat(await collect(encodeExactCsv(sidecar, from(rows))))
    expect(encoded.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

    const decoded = decodeExactCsv(sidecar, splitEvery(encoded, 2))
    expect(await collect(decoded)).toEqual(rows)
  })

  it.each([',', '\t', ';'] as const)('supports the %j delimiter', async (delimiter) => {
    const configured = { ...sidecar, delimiter, bom: false }
    const encoded = Buffer.concat(await collect(encodeExactCsv(configured, from(rows))))
    expect(await collect(decodeExactCsv(configured, from([encoded])))).toEqual(rows)
  })

  it('rejects mismatched headers, duplicate columns, unknown cells, and oversized records', async () => {
    await expect(collect(decodeExactCsv(sidecar, from([
      Buffer.from('wrong,body,nullable\n{}\n'),
    ])))).rejects.toMatchObject({ code: 'CSV_HEADER_MISMATCH' })

    const duplicate = { ...sidecar, columns: [sidecar.columns[0]!, sidecar.columns[0]!] }
    expect(() => decodeExactCsv(duplicate, from([]))).toThrow(ExactCsvFormatError)

    const invalidCell = JSON.stringify({ kind: 'value', type: 'number', value: 1 })
      .replaceAll('"', '""')
    const nullCell = JSON.stringify({ kind: 'null' }).replaceAll('"', '""')
    const invalid = Buffer.from(`id,body,nullable\n"${invalidCell}","${nullCell}","${nullCell}"\n`)
    await expect(collect(decodeExactCsv({ ...sidecar, bom: false }, from([invalid]))))
      .rejects.toMatchObject({ code: 'INVALID_EXACT_CSV' })

    const huge = Buffer.from(`id,body,nullable\n"${'a'.repeat(1_025)}"`)
    await expect(collect(decodeExactCsv({ ...sidecar, bom: false }, from([huge]), {
      maxRecordBytes: 1_024,
    }))).rejects.toMatchObject({ code: 'CSV_RECORD_TOO_LARGE' })
  })
})

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const value of values) collected.push(value)
  return collected
}

async function* from<T>(values: Iterable<T>): AsyncIterable<T> {
  yield* values
}

async function* splitEvery(value: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += size) {
    yield value.subarray(offset, offset + size)
  }
}
