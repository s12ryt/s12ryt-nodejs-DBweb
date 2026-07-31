import { describe, expect, it } from 'vitest'

import {
  ExactJsonFormatError,
  decodeExactJson,
  encodeExactJson,
  type ExactJsonManifest,
  type ExactJsonRecord,
} from './exact-json-format.js'

const manifest: ExactJsonManifest = {
  kind: 'manifest',
  format: 'dbweb-exact-json',
  version: 1,
  tables: [{
    id: 'public.orders',
    schema: 'public',
    table: 'orders',
    columns: [
      { name: 'id', type: 'bigint' },
      { name: 'note', type: 'string' },
      { name: 'payload', type: 'json' },
      { name: 'blob', type: 'binary' },
    ],
  }],
}

const records: ExactJsonRecord[] = [{
  kind: 'row',
  table: 'public.orders',
  values: {
    id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
    note: { kind: 'value', type: 'string', value: '' },
    payload: { kind: 'value', type: 'json', value: { nested: ['x', null, true] } },
    blob: { kind: 'value', type: 'binary', value: 'AP8=' },
  },
}, {
  kind: 'row',
  table: 'public.orders',
  values: {
    id: { kind: 'value', type: 'bigint', value: '2' },
    note: { kind: 'null' },
    payload: { kind: 'default' },
    blob: { kind: 'value', type: 'binary', value: '' },
  },
}]

describe('exact JSON transfer format', () => {
  it('round trips tagged rows through arbitrarily split NDJSON chunks', async () => {
    const encoded = Buffer.concat(await collect(encodeExactJson(manifest, from(records))))
    expect(encoded.toString('utf8').split('\n')[0]).toContain('"dbweb-exact-json"')

    const decoded = await decodeExactJson(splitEvery(encoded, 3))

    expect(decoded.manifest).toEqual(manifest)
    expect(await collect(decoded.records)).toEqual(records)
  })

  it('rejects records before the manifest, unknown tables, and invalid tagged values', async () => {
    await expect(decodeExactJson(from([
      Buffer.from('{"kind":"row","table":"public.orders","values":{}}\n'),
    ]))).rejects.toMatchObject({ code: 'INVALID_EXACT_JSON' })

    const unknownTable = Buffer.from([
      JSON.stringify(manifest),
      JSON.stringify({ kind: 'row', table: 'private.users', values: {} }),
      '',
    ].join('\n'))
    const decoded = await decodeExactJson(from([unknownTable]))
    await expect(collect(decoded.records)).rejects.toMatchObject({ code: 'INVALID_EXACT_JSON' })

    const invalidValue = Buffer.from([
      JSON.stringify(manifest),
      JSON.stringify({
        kind: 'row',
        table: 'public.orders',
        values: { id: { kind: 'value', type: 'bigint', value: '1.5' } },
      }),
      '',
    ].join('\n'))
    const invalid = await decodeExactJson(from([invalidValue]))
    await expect(collect(invalid.records)).rejects.toBeInstanceOf(ExactJsonFormatError)
  })

  it('rejects duplicate table ids and an unterminated oversized line', async () => {
    const duplicate = { ...manifest, tables: [manifest.tables[0]!, manifest.tables[0]!] }
    await expect(decodeExactJson(from([
      Buffer.from(`${JSON.stringify(duplicate)}\n`),
    ]))).rejects.toMatchObject({ code: 'INVALID_EXACT_JSON' })

    await expect(decodeExactJson(from([
      Buffer.alloc(1_025, 0x61),
    ]), { maxLineBytes: 1_024 })).rejects.toMatchObject({ code: 'EXACT_JSON_LINE_TOO_LARGE' })
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
