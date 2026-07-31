import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'
import { TransferUploadError, TransferUploadService } from './transfer-upload-service.js'

const owner: AuthUser = {
  id: 'user-1', username: 'owner', role: 'user', enabled: true, passwordChangeRequired: false,
}
const stranger: AuthUser = {
  ...owner, id: 'user-2', username: 'stranger',
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('TransferUploadService', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ))
  })

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'dbweb-upload-service-'))
    directories.push(root)
    const repository = new MemoryTransferJobRepository()
    const jobs = new TransferJobService(
      repository,
      async () => true,
      () => new Date('2026-07-31T00:00:00.000Z'),
    )
    const store = new EncryptedChunkStore({
      root,
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 7)),
      chunkSizeBytes: 8,
      maxBytes: 24,
    })
    const uploads = new TransferUploadService(
      jobs,
      store,
      8,
      () => new Date('2026-07-31T00:05:00.000Z'),
    )
    return { jobs, store, uploads }
  }

  it('冪等接收chunk、依實際清單更新bytes，並以整檔checksum凍結upload', async () => {
    const { jobs, uploads } = await setup()
    const job = await jobs.create(owner, {
      connectionId: 'connection-1', direction: 'import', format: 'json',
    })
    const first = Buffer.from('12345678')
    const second = Buffer.from('abc')

    await uploads.put(owner, job.id, 1, second, sha256(second))
    await uploads.put(owner, job.id, 0, first, sha256(first))
    await uploads.put(owner, job.id, 0, first, sha256(first))

    expect(await uploads.list(owner, job.id)).toEqual([
      { index: 0, size: 8, checksum: sha256(first) },
      { index: 1, size: 3, checksum: sha256(second) },
    ])
    expect(await jobs.get(owner, job.id)).toMatchObject({ receivedBytes: 11 })

    const whole = Buffer.concat([first, second])
    const completed = await uploads.complete(owner, job.id, whole.length, sha256(whole))
    expect(completed).toMatchObject({
      receivedBytes: 11,
      sourceBytes: 11,
      sourceChecksum: sha256(whole),
      uploadCompletedAt: '2026-07-31T00:05:00.000Z',
    })
    await expect(uploads.put(owner, job.id, 2, Buffer.from('x'), sha256(Buffer.from('x'))))
      .rejects.toEqual(new TransferUploadError('UPLOAD_ALREADY_COMPLETED'))
  })

  it('拒絕非建立者、export job、缺段及錯誤整檔checksum', async () => {
    const { jobs, uploads } = await setup()
    const importJob = await jobs.create(owner, {
      connectionId: 'connection-1', direction: 'import', format: 'csv',
    })
    const content = Buffer.from('tail')

    await expect(uploads.put(stranger, importJob.id, 0, content, sha256(content)))
      .rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    await uploads.put(owner, importJob.id, 1, content, sha256(content))
    await expect(uploads.complete(owner, importJob.id, content.length, sha256(content)))
      .rejects.toEqual(new TransferUploadError('INCOMPLETE_UPLOAD'))

    const checksumJob = await jobs.create(owner, {
      connectionId: 'connection-2', direction: 'import', format: 'json',
    })
    await uploads.put(owner, checksumJob.id, 0, content, sha256(content))
    await expect(uploads.complete(owner, checksumJob.id, content.length, '0'.repeat(64)))
      .rejects.toEqual(new TransferUploadError('FILE_CHECKSUM_MISMATCH'))

    const exportJob = await jobs.create(stranger, {
      connectionId: 'connection-3', direction: 'export', format: 'sql',
    })
    await expect(uploads.put(stranger, exportJob.id, 0, content, sha256(content)))
      .rejects.toEqual(new TransferUploadError('UPLOAD_NOT_ALLOWED'))
  })

  it('每次寫入都重新檢查即時授權', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dbweb-upload-auth-'))
    directories.push(root)
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true)
    let allowed = true
    const uploads = new TransferUploadService(
      jobs,
      new EncryptedChunkStore({
        root, encryption: new EnvelopeEncryption(Buffer.alloc(32, 8)), chunkSizeBytes: 8,
      }),
      8,
      () => new Date(),
      async () => allowed,
    )
    const job = await jobs.create(owner, {
      connectionId: 'connection-1', direction: 'import', format: 'csv',
    })
    allowed = false

    const content = Buffer.from('blocked')
    await expect(uploads.put(owner, job.id, 0, content, sha256(content)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('完成整檔checksum驗證後記錄bytes與checksum稽核', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dbweb-upload-audit-'))
    directories.push(root)
    const record = vi.fn(async () => undefined)
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true)
    const uploads = new TransferUploadService(
      jobs,
      new EncryptedChunkStore({
        root, encryption: new EnvelopeEncryption(Buffer.alloc(32, 9)), chunkSizeBytes: 8,
      }),
      8,
      () => new Date('2026-07-31T00:05:00.000Z'),
      async () => true,
      { record },
    )
    const job = await jobs.create(owner, {
      connectionId: 'connection-1', direction: 'import', format: 'json',
    })
    const content = Buffer.from('payload')
    const checksum = sha256(content)
    await uploads.put(owner, job.id, 0, content, checksum)

    await uploads.complete(owner, job.id, content.length, checksum)

    expect(record).toHaveBeenCalledWith({
      actorId: owner.id,
      jobId: job.id,
      connectionId: 'connection-1',
      direction: 'import',
      format: 'json',
      action: 'upload-complete',
      status: 'success',
      details: { bytes: content.length, checksum },
    })
  })
})
