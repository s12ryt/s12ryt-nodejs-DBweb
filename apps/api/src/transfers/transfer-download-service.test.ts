import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { TransferDownloadError, TransferDownloadService } from './transfer-download-service.js'
import { MemoryTransferJobRepository, TransferJobService, transitionTransferJob } from './transfer-job.js'

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('TransferDownloadService', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true })))
  })

  async function setup() {
    const repository = new MemoryTransferJobRepository()
    const jobs = new TransferJobService(repository, async () => true)
    const actor = { id: 'user-1', role: 'user' as const }
    const root = await mkdtemp(join(tmpdir(), 'dbweb-transfer-download-'))
    directories.push(root)
    const output = new EncryptedChunkStore({
      root,
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 13)),
      purposeNamespace: 'output',
      chunkSizeBytes: 8,
    })
    let authorized = true
    const downloads = new TransferDownloadService(
      jobs,
      output,
      async () => authorized,
    )
    return { actor, downloads, jobs, output, setAuthorized: (value: boolean) => { authorized = value } }
  }

  it('串流讀取成功export的連續加密輸出chunks', async () => {
    const environment = await setup()
    const job = await environment.jobs.create(environment.actor, {
      connectionId: 'connection-1', direction: 'export', format: 'json',
    })
    await environment.jobs.update(environment.actor, job.id, (current) =>
      transitionTransferJob(current, 'previewed', { updatedAt: current.updatedAt }))
    await environment.jobs.update(environment.actor, job.id, (current) =>
      transitionTransferJob(current, 'running', { updatedAt: current.updatedAt }))
    await environment.jobs.update(environment.actor, job.id, (current) =>
      transitionTransferJob(current, 'succeeded', { updatedAt: current.updatedAt }))
    const first = Buffer.from('12345678')
    const second = Buffer.from('tail')
    await environment.output.put(job.id, 0, first, sha256(first))
    await environment.output.put(job.id, 1, second, sha256(second))

    const download = await environment.downloads.open(environment.actor, job.id)
    const chunks: Buffer[] = []
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([first, second]))
    expect(download).toMatchObject({ size: 12, filename: `${job.id}.json` })
  })

  it('拒絕未完成、非export、缺段及能力已撤銷的下載', async () => {
    const environment = await setup()
    const pending = await environment.jobs.create(environment.actor, {
      connectionId: 'connection-1', direction: 'export', format: 'csv',
    })
    await expect(environment.downloads.open(environment.actor, pending.id)).rejects.toThrow(
      new TransferDownloadError('DOWNLOAD_NOT_READY'),
    )
    const imported = await environment.jobs.create(
      { id: 'user-2', role: 'user' },
      { connectionId: 'connection-2', direction: 'import', format: 'json' },
    )
    await expect(environment.downloads.open(
      { id: 'user-2', role: 'user' },
      imported.id,
    )).rejects.toThrow(new TransferDownloadError('DOWNLOAD_NOT_READY'))

    environment.setAuthorized(false)
    await expect(environment.downloads.open(environment.actor, pending.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('開啟安全下載時記錄輸出bytes但不讀取原始內容到稽核', async () => {
    const repository = new MemoryTransferJobRepository()
    const jobs = new TransferJobService(repository, async () => true)
    const actor = { id: 'user-1', role: 'user' as const }
    const root = await mkdtemp(join(tmpdir(), 'dbweb-transfer-download-audit-'))
    directories.push(root)
    const output = new EncryptedChunkStore({
      root,
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 14)),
      purposeNamespace: 'output',
      chunkSizeBytes: 8,
    })
    const record = vi.fn(async () => undefined)
    const downloads = new TransferDownloadService(jobs, output, async () => true, { record })
    const job = await jobs.create(actor, {
      connectionId: 'connection-1', direction: 'export', format: 'csv',
    })
    await jobs.update(actor, job.id, (current) =>
      transitionTransferJob(current, 'previewed', { updatedAt: current.updatedAt }))
    await jobs.update(actor, job.id, (current) =>
      transitionTransferJob(current, 'running', { updatedAt: current.updatedAt }))
    await jobs.update(actor, job.id, (current) =>
      transitionTransferJob(current, 'succeeded', { updatedAt: current.updatedAt }))
    const content = Buffer.from('download')
    await output.put(job.id, 0, content, sha256(content))

    await downloads.open(actor, job.id)

    expect(record).toHaveBeenCalledWith({
      actorId: actor.id,
      jobId: job.id,
      connectionId: 'connection-1',
      direction: 'export',
      format: 'csv',
      action: 'download',
      status: 'success',
      details: { bytes: content.length },
    })
  })
})
