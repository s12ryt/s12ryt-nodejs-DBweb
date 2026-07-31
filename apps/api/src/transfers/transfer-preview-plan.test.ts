import { createHash, randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  EncryptedTransferPreviewPlanStore,
  MemoryTransferPreviewPlanRepository,
  TransferPreviewPlanError,
} from './transfer-preview-plan.js'
import { TransferPreviewTokenService, type TransferPreviewFingerprint } from './transfer-preview-token.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fingerprint(jobId: string): TransferPreviewFingerprint {
  return {
    jobId,
    sourceChecksum: hash('source'),
    mappingHash: hash('mapping'),
    strategyHash: hash('strategy'),
    targetHash: hash('target'),
    capabilityHash: hash('capability'),
    schemaFingerprint: hash('schema'),
  }
}

describe('EncryptedTransferPreviewPlanStore', () => {
  it('encrypts an immutable plan and validates its signed fingerprint before execution', async () => {
    const jobId = randomUUID()
    const now = new Date('2026-07-31T12:00:00.000Z')
    const repository = new MemoryTransferPreviewPlanRepository()
    const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 41), () => now)
    const store = new EncryptedTransferPreviewPlanStore(
      repository,
      new EnvelopeEncryption(Buffer.alloc(32, 42)),
      tokens,
      () => now,
    )
    const expected = fingerprint(jobId)
    const plan = { kind: 'friendly-csv-export', table: { schema: 'public', name: 'orders' } }
    const token = tokens.issue(expected)

    await store.save(jobId, expected, plan)

    await expect(store.validate(jobId, token)).resolves.toEqual(plan)
    const [stored] = repository.entries
    expect(stored).toMatchObject({ jobId, expiresAt: '2026-07-31T12:30:00.000Z' })
    expect(JSON.stringify(stored)).not.toContain('orders')
  })

  it('rejects a changed token, a different job, and an expired stored plan', async () => {
    const jobId = randomUUID()
    let now = new Date('2026-07-31T12:00:00.000Z')
    const repository = new MemoryTransferPreviewPlanRepository()
    const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 43), () => now)
    const store = new EncryptedTransferPreviewPlanStore(
      repository,
      new EnvelopeEncryption(Buffer.alloc(32, 44)),
      tokens,
      () => now,
    )
    const expected = fingerprint(jobId)
    await store.save(jobId, expected, { kind: 'plan' })

    const changed = tokens.issue({ ...expected, schemaFingerprint: hash('changed') })
    await expect(store.validate(jobId, changed)).rejects.toEqual(
      new TransferPreviewPlanError('PREVIEW_CHANGED'),
    )
    await expect(store.validate(randomUUID(), tokens.issue(expected))).rejects.toEqual(
      new TransferPreviewPlanError('PREVIEW_NOT_FOUND'),
    )

    now = new Date('2026-07-31T12:30:00.001Z')
    await expect(store.validate(jobId, tokens.issue(expected))).rejects.toEqual(
      new TransferPreviewPlanError('PREVIEW_EXPIRED'),
    )
  })
})
