import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore, TransferChunkError } from './encrypted-chunk-store.js'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('EncryptedChunkStore', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) => rm(directory, {
      recursive: true,
      force: true,
    })))
  })

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'dbweb-transfer-'))
    directories.push(root)
    const store = new EncryptedChunkStore({
      root,
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 9)),
      chunkSizeBytes: 8,
      maxBytes: 24,
    })
    return { root, store }
  }

  it('驗證 checksum、加密落盤並可依序列出與讀回二進位 chunk', async () => {
    const { root, store } = await setup()
    const second = Buffer.from([0, 255, 2])
    const first = Buffer.from('secret-1')

    await store.put(JOB_ID, 1, second, sha256(second))
    await store.put(JOB_ID, 0, first, sha256(first))

    expect(await store.list(JOB_ID)).toEqual([
      { index: 0, size: 8, checksum: sha256(first) },
      { index: 1, size: 3, checksum: sha256(second) },
    ])
    expect(await store.read(JOB_ID, 0)).toEqual(first)
    expect(await store.read(JOB_ID, 1)).toEqual(second)

    const jobFiles = await readdir(join(root, JOB_ID))
    const raw = await Promise.all(jobFiles.map(async (file) => readFile(join(root, JOB_ID, file))))
    expect(Buffer.concat(raw).includes(Buffer.from('secret-1'))).toBe(false)
  })

  it('允許相同chunk冪等重送，但拒絕checksum錯誤、內容衝突與大小超限', async () => {
    const { store } = await setup()
    const original = Buffer.from('original')
    const replacement = Buffer.from('replaced')

    expect(await store.put(JOB_ID, 0, original, sha256(original))).toEqual({
      index: 0,
      size: 8,
      checksum: sha256(original),
    })
    expect(await store.put(JOB_ID, 0, original, sha256(original))).toEqual({
      index: 0,
      size: 8,
      checksum: sha256(original),
    })
    await expect(store.put(JOB_ID, 0, replacement, sha256(replacement))).rejects.toMatchObject({
      code: 'CHUNK_CONFLICT',
    })
    await expect(store.put(JOB_ID, 1, Buffer.from('bad'), '0'.repeat(64))).rejects.toMatchObject({
      code: 'CHUNK_CHECKSUM_MISMATCH',
    })
    await expect(store.put(JOB_ID, 1, Buffer.alloc(9), sha256(Buffer.alloc(9)))).rejects.toMatchObject({
      code: 'CHUNK_TOO_LARGE',
    })
    await expect(store.put(JOB_ID, 3, Buffer.alloc(1), sha256(Buffer.alloc(1)))).rejects.toMatchObject({
      code: 'TRANSFER_TOO_LARGE',
    })
  })

  it('拒絕路徑注入與遭篡改的chunk，並可清除整個job', async () => {
    const { root, store } = await setup()
    const content = Buffer.from('payload')
    await store.put(JOB_ID, 0, content, sha256(content))

    await expect(store.put('../escape', 0, content, sha256(content))).rejects.toBeInstanceOf(
      TransferChunkError,
    )
    await writeFile(join(root, JOB_ID, '0.chunk'), Buffer.from('tampered'))
    await expect(store.read(JOB_ID, 0)).rejects.toMatchObject({ code: 'CHUNK_CORRUPTED' })

    await store.deleteJob(JOB_ID)
    expect(await store.list(JOB_ID)).toEqual([])
  })

  it('以用途命名空間隔離來源與輸出，拒絕跨store複製密文', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'dbweb-transfer-source-'))
    const outputRoot = await mkdtemp(join(tmpdir(), 'dbweb-transfer-output-'))
    directories.push(sourceRoot, outputRoot)
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 12))
    const source = new EncryptedChunkStore({
      root: sourceRoot,
      encryption,
      purposeNamespace: 'source',
    })
    const output = new EncryptedChunkStore({
      root: outputRoot,
      encryption,
      purposeNamespace: 'output',
    })
    const content = Buffer.from('namespace-bound')
    await source.put(JOB_ID, 0, content, sha256(content))
    await mkdir(join(outputRoot, JOB_ID), { recursive: true })
    await copyFile(
      join(sourceRoot, JOB_ID, '0.chunk'),
      join(outputRoot, JOB_ID, '0.chunk'),
    )

    await expect(output.read(JOB_ID, 0)).rejects.toMatchObject({ code: 'CHUNK_CORRUPTED' })
  })
})
