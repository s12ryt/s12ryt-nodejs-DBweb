import { describe, expect, it } from 'vitest'

import { buildNativeGrantPlan } from '../accounts/native-grant-plan.js'
import { decodeKeysetCursor } from '../database/keyset-pagination.js'
import { detectDdlCapabilities } from '../ddl/ddl-capabilities.js'
import { buildDdlStatements } from '../ddl/ddl-sql-builder.js'
import { readSafeTar, writeSafeTar } from '../transfers/safe-tar.js'

const emptyContent: AsyncIterable<Uint8Array> = {
  async *[Symbol.asyncIterator]() {
    yield Buffer.alloc(0)
  },
}

describe('deterministic hostile input corpus', () => {
  it('rejects traversal and ambiguous archive paths', async () => {
    const paths = [
      '../secret',
      './entry',
      '/absolute',
      'nested//entry',
      'nested/../entry',
      'nested\\entry',
      'entry\0suffix',
    ]

    for (const path of paths) {
      await expect(collect(writeSafeTar([{ path, size: 0, content: emptyContent }]))).rejects.toMatchObject({
        code: 'UNSAFE_TAR_PATH',
      })
    }
  })

  it('rejects deterministic tar header checksum mutations', async () => {
    const valid = Buffer.concat(await collect(writeSafeTar([{
      path: 'data.ndjson',
      size: 4,
      content: chunks(Buffer.from('data')),
    }])))

    for (const offset of [0, 1, 10, 100, 124, 136, 147, 156, 257, 511]) {
      const mutated = Buffer.from(valid)
      mutated[offset] = mutated[offset]! ^ 0x01
      await expect(readSafeTar(chunks(mutated), async () => undefined)).rejects.toMatchObject({
        code: expect.stringMatching(/^(INVALID_TAR|UNSUPPORTED_TAR_ENTRY)$/),
      })
    }
  })

  it('rejects malformed and non-canonical keyset cursors', () => {
    const cursors = [
      '',
      '***',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('{"v":1,"key":["id"],"values":[1],"direction":"sideways"}').toString('base64url'),
      Buffer.from('{ "v":1,"key":["id"],"values":[1],"direction":"forward"}').toString('base64url'),
      Buffer.from('{"v":1,"key":["other"],"values":[1],"direction":"forward"}').toString('base64url'),
    ]

    for (const cursor of cursors) {
      expect(() => decodeKeysetCursor(cursor, ['id'])).toThrow('INVALID_KEYSET_CURSOR')
    }
  })

  it('rejects SQL fragment breakout tokens across advanced indexes', () => {
    const capabilities = detectDdlCapabilities('postgres', '17.0')
    const fragments = [
      'lower(email); DROP TABLE users',
      'lower(email)--comment',
      'lower(email)/*comment*/',
      'lower(email)\0suffix',
      '`email`',
    ]

    for (const expression of fragments) {
      expect(() => buildDdlStatements(capabilities, {
        kind: 'create-index',
        schema: 'public',
        table: 'users',
        name: 'users_email_idx',
        method: 'btree',
        unique: false,
        parts: [{ expression }],
        confirmed: true,
      })).toThrow('DDL_INVALID_FRAGMENT')
    }
  })

  it('rejects control characters in native grant identifiers', () => {
    for (const database of ['analytics\0shadow', 'analytics\nshadow', 'analytics\rshadow', 'analytics\u007fshadow']) {
      expect(() => buildNativeGrantPlan('postgres', {
        kind: 'grant',
        identity: { engine: 'postgres', username: 'reader' },
        changes: [{ scope: 'database', database, privileges: ['connect'] }],
      })).toThrow('INVALID_NATIVE_GRANT')
    }
  })
})

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}

async function* chunks(value: Uint8Array): AsyncIterable<Buffer> {
  yield Buffer.from(value)
}
