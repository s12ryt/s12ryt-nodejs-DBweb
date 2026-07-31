import { describe, expect, it } from 'vitest'

import type { ExactJsonManifest, ExactJsonRecord } from './exact-json-format.js'
import { encodeExactJson } from './exact-json-format.js'
import { ExactJsonPackageError, readExactJsonPackage } from './exact-json-package-reader.js'
import { writeSafeTar } from './safe-tar.js'

const manifest: ExactJsonManifest = {
  kind: 'manifest', format: 'dbweb-exact-json', version: 1,
  tables: [{ id: 'users', schema: 'public', table: 'users', columns: [{ name: 'id', type: 'bigint' }] }],
}
const records: ExactJsonRecord[] = [
  { kind: 'row', table: 'users', values: { id: { kind: 'value', type: 'bigint', value: '9007199254740993' } } },
]

describe('readExactJsonPackage', () => {
  it.each(['none', 'gzip'] as const)('streams the NDJSON entry from a %s package', async (compression) => {
    const data = Buffer.concat(await collect(encodeExactJson(manifest, from(records))))
    const archive = writeSafeTar([{
      path: 'data.ndjson', size: data.length, content: from([data]),
    }], { compression })
    const received: ExactJsonRecord[] = []

    const result = await readExactJsonPackage(split(archive, 5), async (decodedManifest, decodedRecords) => {
      expect(decodedManifest).toEqual(manifest)
      for await (const record of decodedRecords) received.push(record)
      return 'handled'
    }, { compression })

    expect(result).toBe('handled')
    expect(received).toEqual(records)
  })

  it('rejects missing, duplicate, and unexpected package entries', async () => {
    await expect(readExactJsonPackage(writeSafeTar([]), async () => undefined)).rejects.toEqual(
      new ExactJsonPackageError('INVALID_EXACT_JSON_PACKAGE'),
    )
    const data = Buffer.concat(await collect(encodeExactJson(manifest, from(records))))
    await expect(readExactJsonPackage(writeSafeTar([
      { path: 'data.ndjson', size: data.length, content: from([data]) },
      { path: 'extra.txt', size: 1, content: from([Buffer.from('x')]) },
    ]), async () => undefined)).rejects.toEqual(
      new ExactJsonPackageError('INVALID_EXACT_JSON_PACKAGE'),
    )
  })

  it('preserves handler domain errors instead of misclassifying them as package corruption', async () => {
    const data = Buffer.concat(await collect(encodeExactJson(manifest, from(records))))
    const failure = new Error('HANDLER_DOMAIN_FAILURE')

    await expect(readExactJsonPackage(writeSafeTar([{
      path: 'data.ndjson', size: data.length, content: from([data]),
    }]), async () => { throw failure })).rejects.toBe(failure)
  })
})

async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }

async function* split(chunks: AsyncIterable<Uint8Array>, size: number): AsyncIterable<Buffer> {
  for await (const chunk of chunks) {
    const value = Buffer.from(chunk)
    for (let offset = 0; offset < value.length; offset += size) yield value.subarray(offset, offset + size)
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}
