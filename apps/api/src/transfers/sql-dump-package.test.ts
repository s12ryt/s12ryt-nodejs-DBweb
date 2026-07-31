import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SqlDumpManifest } from './sql-dump-manifest.js'
import {
  readSqlDumpPackage,
  SqlDumpPackageError,
  writeSqlDumpPackage,
} from './sql-dump-package.js'

describe('SQL dump package', () => {
  it.each(['none', 'gzip'] as const)('round trips checksummed entries with %s compression', async (compression) => {
    const data = Buffer.from('{"kind":"row"}\n')
    const manifest = manifestFor(data)
    const archive = collect(writeSqlDumpPackage(manifest, [{
      path: manifest.entries[0]!.path,
      size: data.length,
      sha256: hash(data),
      content: chunks(data, 3),
    }], { compression }))
    const seen: Buffer[] = []

    const restored = await readSqlDumpPackage(chunks(await archive, 5), async (actual, entry, content) => {
      expect(actual).toEqual(manifest)
      expect(entry.path).toBe('data/public.orders.ndjson')
      seen.push(await collect(content))
    }, { compression })

    expect(restored.entries).toBe(1)
    expect(Buffer.concat(seen)).toEqual(data)
  })

  it('rejects missing, reordered, additional, and checksummed entry content', async () => {
    const data = Buffer.from('payload')
    const manifest = manifestFor(data)
    await expect(collect(writeSqlDumpPackage(manifest, [], {}))).rejects.toEqual(
      new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE'),
    )
    await expect(collect(writeSqlDumpPackage(manifest, [{
      path: 'wrong', size: data.length, sha256: hash(data), content: chunks(data, 2),
    }], {}))).rejects.toEqual(new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE'))
    await expect(collect(writeSqlDumpPackage(manifest, [
      { path: manifest.entries[0]!.path, size: data.length, sha256: hash(data), content: chunks(data, 2) },
      { path: 'extra', size: 0, sha256: hash(Buffer.alloc(0)), content: chunks(Buffer.alloc(0), 1) },
    ], {}))).rejects.toEqual(new SqlDumpPackageError('INVALID_SQL_DUMP_PACKAGE'))
    await expect(collect(writeSqlDumpPackage(manifest, [{
      path: manifest.entries[0]!.path,
      size: data.length,
      sha256: hash(data),
      content: chunks(Buffer.from('tampered'), 2),
    }], {}))).rejects.toEqual(new SqlDumpPackageError('SQL_DUMP_CHECKSUM_MISMATCH'))
  })

  it('preserves handler domain errors', async () => {
    const data = Buffer.from('payload')
    const manifest = manifestFor(data)
    const archive = await collect(writeSqlDumpPackage(manifest, [{
      path: manifest.entries[0]!.path,
      size: data.length,
      sha256: hash(data),
      content: chunks(data, 2),
    }]))
    const expected = new Error('restore-domain-error')

    await expect(readSqlDumpPackage(chunks(archive, 4), async () => {
      throw expected
    })).rejects.toBe(expected)
  })
})

function manifestFor(data: Buffer): SqlDumpManifest {
  return {
    format: 'dbweb-sql-dump', version: 1, engine: 'postgres', serverVersion: '17.5', database: 'app',
    scope: { kind: 'table', schema: 'public', table: 'orders' },
    objects: [{
      id: 'table:public.orders', kind: 'table', schema: 'public', name: 'orders', dependencies: [],
      createCommands: [{
        kind: 'create-table', schema: 'public', name: 'orders',
        columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
      }],
      dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
      dataEntry: 'data/public.orders.ndjson',
    }],
    entries: [{
      path: 'data/public.orders.ndjson', size: data.length, sha256: hash(data),
      objectId: 'table:public.orders', kind: 'data',
    }],
  }
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function* chunks(value: Uint8Array, size: number): AsyncIterable<Buffer> {
  for (let offset = 0; offset < value.length; offset += size) yield Buffer.from(value.subarray(offset, offset + size))
}

async function collect(values: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Buffer[] = []
  for await (const value of values) result.push(Buffer.from(value))
  return Buffer.concat(result)
}
