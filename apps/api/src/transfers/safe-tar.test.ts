import { describe, expect, it } from 'vitest'

import {
  SafeTarError,
  readSafeTar,
  writeSafeTar,
  type SafeTarEntry,
} from './safe-tar.js'

describe('safe tar packages', () => {
  it.each(['none', 'gzip'] as const)('streams regular files through %s compression', async (compression) => {
    const entries: SafeTarEntry[] = [{
      path: 'manifest.json',
      size: 12,
      content: from([Buffer.from('{"ok":true}\n')]),
    }, {
      path: 'data/orders.ndjson',
      size: 11,
      content: from([Buffer.from('first\n'), Buffer.from('last\n')]),
    }]
    const archive = Buffer.concat(await collect(writeSafeTar(entries, { compression })))
    const extracted = new Map<string, Buffer>()

    await readSafeTar(splitEvery(archive, 7), async (entry, content) => {
      extracted.set(entry.path, Buffer.concat(await collect(content)))
    }, { compression })

    expect([...extracted]).toEqual([
      ['manifest.json', Buffer.from('{"ok":true}\n')],
      ['data/orders.ndjson', Buffer.from('first\nlast\n')],
    ])
  })

  it('rejects unsafe and duplicate output paths before writing content', async () => {
    for (const path of ['../secret', '/absolute', 'safe/../../secret', 'safe\\file']) {
      await expect(collect(writeSafeTar([{ path, size: 0, content: from([]) }]))).
        rejects.toBeInstanceOf(SafeTarError)
    }
    await expect(collect(writeSafeTar([
      { path: 'same', size: 0, content: from([]) },
      { path: 'same', size: 0, content: from([]) },
    ]))).rejects.toMatchObject({ code: 'DUPLICATE_TAR_ENTRY' })
  })

  it('rejects links, invalid checksums, and undeclared content sizes', async () => {
    const regular = Buffer.concat(await collect(writeSafeTar([{
      path: 'data', size: 1, content: from([Buffer.from('x')]),
    }])))
    const link = Buffer.from(regular)
    link[156] = '2'.charCodeAt(0)
    rewriteChecksum(link.subarray(0, 512))
    await expect(readSafeTar(from([link]), async () => undefined)).rejects
      .toMatchObject({ code: 'UNSUPPORTED_TAR_ENTRY' })

    const corrupted = Buffer.from(regular)
    corrupted[0] = corrupted[0]! ^ 1
    await expect(readSafeTar(from([corrupted]), async () => undefined)).rejects
      .toMatchObject({ code: 'INVALID_TAR' })

    await expect(collect(writeSafeTar([{
      path: 'short', size: 2, content: from([Buffer.from('x')]),
    }]))).rejects.toMatchObject({ code: 'TAR_SIZE_MISMATCH' })
  })

  it('enforces expanded entry and total limits for gzip archives', async () => {
    const archive = Buffer.concat(await collect(writeSafeTar([{
      path: 'large', size: 2_048, content: from([Buffer.alloc(2_048, 0x61)]),
    }], { compression: 'gzip' })))

    await expect(readSafeTar(from([archive]), async (_entry, content) => {
      await collect(content)
    }, { compression: 'gzip', maxEntryBytes: 1_024 })).rejects
      .toMatchObject({ code: 'TAR_LIMIT_EXCEEDED' })
    await expect(readSafeTar(from([archive]), async (_entry, content) => {
      await collect(content)
    }, { compression: 'gzip', maxTotalBytes: 1_024 })).rejects
      .toMatchObject({ code: 'TAR_LIMIT_EXCEEDED' })
  })
})

function rewriteChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

async function* from<T>(values: Iterable<T>): AsyncIterable<T> {
  yield* values
}

async function* splitEvery(value: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += size) {
    yield value.subarray(offset, offset + size)
  }
}
