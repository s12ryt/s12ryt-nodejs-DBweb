import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'
import {
  TransferPreviewError,
  TransferPreviewService,
  type TransferPreviewInspection,
} from './transfer-preview-service.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'

const actor = { id: 'user-1', role: 'user' as const }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function inspection(jobId: string): TransferPreviewInspection {
  return {
    fingerprint: {
      jobId,
      sourceChecksum: hash('source'),
      mappingHash: hash('mapping'),
      strategyHash: hash('strategy'),
      targetHash: hash('target'),
      capabilityHash: hash('capability'),
      schemaFingerprint: hash('schema'),
    },
    estimatedBytes: 128,
    estimatedRows: 3,
    estimatedTables: 1,
    issues: [{ line: 2, column: 'amount', code: 'INVALID_VALUE', summary: 'invalid decimal' }],
    plan: { kind: 'csv-import', table: 'orders' },
  }
}

describe('TransferPreviewService', () => {
  it('只用server inspector產生fingerprint、簽發30分鐘token並轉移job狀態', async () => {
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true)
    const job = await jobs.create(actor, {
      connectionId: 'connection-1', direction: 'import', format: 'csv',
    })
    await jobs.update(actor, job.id, (current) => ({
      ...current,
      sourceBytes: 128,
      sourceChecksum: hash('source'),
      uploadCompletedAt: '2026-07-31T00:00:00.000Z',
    }))
    const inspect = vi.fn(async () => inspection(job.id))
    const record = vi.fn(async () => undefined)
    const save = vi.fn(async () => undefined)
    const tokens = new TransferPreviewTokenService(
      Buffer.alloc(32, 19),
      () => new Date('2026-07-31T00:00:00.000Z'),
    )
    const service = new TransferPreviewService(jobs, { inspect }, tokens, { save }, { record })

    const result = await service.preview(actor, job.id, {
      mapping: { amount: 'total' },
      strategy: { conflict: 'skip' },
      target: { schema: 'public', table: 'orders' },
    })

    expect(inspect).toHaveBeenCalledWith(actor, expect.objectContaining({ id: job.id }), {
      mapping: { amount: 'total' },
      strategy: { conflict: 'skip' },
      target: { schema: 'public', table: 'orders' },
    })
    expect(result).toMatchObject({
      estimatedBytes: 128,
      estimatedRows: 3,
      estimatedTables: 1,
      issues: [{ code: 'INVALID_VALUE' }],
      token: expect.stringMatching(/^v1\./),
    })
    expect(tokens.verify(result.token, inspection(job.id).fingerprint)).toMatchObject({
      jobId: job.id,
    })
    expect(save).toHaveBeenCalledWith(
      job.id,
      inspection(job.id).fingerprint,
      { kind: 'csv-import', table: 'orders' },
    )
    expect(await jobs.get(actor, job.id)).toMatchObject({ status: 'previewed' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: actor.id,
      jobId: job.id,
      action: 'preview',
      status: 'success',
    }))
  })

  it('拒絕未完成上傳、錯誤job fingerprint及超過100筆preview issues', async () => {
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true)
    const job = await jobs.create(actor, {
      connectionId: 'connection-1', direction: 'import', format: 'json',
    })
    const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 20))
    const incomplete = new TransferPreviewService(jobs, {
      inspect: async () => inspection(job.id),
    }, tokens, { save: async () => undefined })
    await expect(incomplete.preview(actor, job.id, {
      mapping: {}, strategy: {}, target: {},
    })).rejects.toEqual(new TransferPreviewError('UPLOAD_INCOMPLETE'))

    await jobs.update(actor, job.id, (current) => ({
      ...current,
      sourceBytes: 1,
      sourceChecksum: hash('source'),
      uploadCompletedAt: new Date().toISOString(),
    }))
    const wrongJob = new TransferPreviewService(jobs, {
      inspect: async () => inspection('00000000-0000-4000-8000-000000000099'),
    }, tokens, { save: async () => undefined })
    await expect(wrongJob.preview(actor, job.id, {
      mapping: {}, strategy: {}, target: {},
    })).rejects.toEqual(new TransferPreviewError('INVALID_PREVIEW'))

    const tooMany = new TransferPreviewService(jobs, {
      inspect: async () => ({
        ...inspection(job.id),
        issues: Array.from({ length: 101 }, () => ({ code: 'ERROR', summary: 'masked' })),
      }),
    }, tokens, { save: async () => undefined })
    await expect(tooMany.preview(actor, job.id, {
      mapping: {}, strategy: {}, target: {},
    })).rejects.toEqual(new TransferPreviewError('INVALID_PREVIEW'))
  })
})
