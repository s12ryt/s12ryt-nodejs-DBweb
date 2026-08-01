import { createHash } from 'node:crypto'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { TransferChunkError } from './encrypted-chunk-store.js'
import {
  S3EncryptedChunkStore,
  type S3ChunkClient,
} from './s3-encrypted-chunk-store.js'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

class MemoryS3Client implements S3ChunkClient {
  readonly objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>()

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw Object.assign(new Error('precondition'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        })
      }
      this.objects.set(key, {
        body: Buffer.from(command.input.Body as Uint8Array),
        metadata: command.input.Metadata ?? {},
      })
      return {}
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!)
      if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      return {
        Body: { transformToByteArray: async () => object.body },
        Metadata: object.metadata,
      }
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? ''
      return {
        Contents: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, value]) => ({ Key, Size: value.body.length })),
        IsTruncated: false,
      }
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!)
      return {}
    }
    throw new Error('unexpected-command')
  }
}

describe('S3EncryptedChunkStore', () => {
  it('以用途綁定密文保存、讀取、排序列出並刪除chunks', async () => {
    const client = new MemoryS3Client()
    const store = new S3EncryptedChunkStore({
      client,
      bucket: 'dbweb',
      prefix: 'transfers',
      purposeNamespace: 'source',
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 7)),
      chunkSizeBytes: 64,
      maxBytes: 256,
    })
    const first = Buffer.from('first-secret')
    const second = Buffer.from('second-secret')

    await store.put(JOB_ID, 1, second, sha256(second))
    await store.put(JOB_ID, 0, first, sha256(first))

    expect([...client.objects.values()][0]?.body.includes(second)).toBe(false)
    await expect(store.read(JOB_ID, 0)).resolves.toEqual(first)
    await expect(store.list(JOB_ID)).resolves.toEqual([
      { index: 0, size: first.length, checksum: sha256(first) },
      { index: 1, size: second.length, checksum: sha256(second) },
    ])
    await store.deleteJob(JOB_ID)
    expect(client.objects).toHaveLength(0)
  })

  it('相同chunk冪等，不同內容衝突，跨namespace複製密文無法解密', async () => {
    const client = new MemoryS3Client()
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 9))
    const source = new S3EncryptedChunkStore({
      client, bucket: 'dbweb', prefix: 'transfers', purposeNamespace: 'source',
      encryption, chunkSizeBytes: 64, maxBytes: 256,
    })
    const output = new S3EncryptedChunkStore({
      client, bucket: 'dbweb', prefix: 'transfers', purposeNamespace: 'output',
      encryption, chunkSizeBytes: 64, maxBytes: 256,
    })
    const content = Buffer.from('same-secret')

    await source.put(JOB_ID, 0, content, sha256(content))
    await expect(source.put(JOB_ID, 0, content, sha256(content))).resolves.toMatchObject({ index: 0 })
    const different = Buffer.from('different')
    await expect(source.put(JOB_ID, 0, different, sha256(different)))
      .rejects.toEqual(new TransferChunkError('CHUNK_CONFLICT'))

    const sourceKey = [...client.objects.keys()][0]!
    const copied = client.objects.get(sourceKey)!
    client.objects.set(sourceKey.replace('/source/', '/output/'), copied)
    await expect(output.read(JOB_ID, 0))
      .rejects.toEqual(new TransferChunkError('CHUNK_CORRUPTED'))
  })
})
