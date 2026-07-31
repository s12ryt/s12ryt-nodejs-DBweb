import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { StoredTransferPreviewPlan } from '../transfers/transfer-preview-plan.js'
import { KyselyTransferPreviewPlanRepository } from './kysely-transfer-preview-plan-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('KyselyTransferPreviewPlanRepository', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true }))))

  it('replaces a job plan, survives SQLite restart, and never stores plan plaintext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-transfer-preview-'))
    directories.push(directory)
    const filename = join(directory, 'metadata.sqlite')
    const first = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(first)
    const repository = new KyselyTransferPreviewPlanRepository(first)
    const initial: StoredTransferPreviewPlan = {
      jobId: '11111111-1111-4111-8111-111111111111',
      encryptedPayload: 'v1.encrypted-sensitive-preview-plan',
      expiresAt: '2026-07-31T12:30:00.000Z',
      updatedAt: '2026-07-31T12:00:00.000Z',
    }
    const replacement = {
      ...initial,
      encryptedPayload: 'v1.replaced-preview-plan',
      updatedAt: '2026-07-31T12:01:00.000Z',
    }

    await repository.save(initial)
    await repository.save(replacement)
    await first.destroy()

    const reopened = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(reopened)
    const persisted = new KyselyTransferPreviewPlanRepository(reopened)
    await expect(persisted.find(initial.jobId)).resolves.toEqual(replacement)
    await expect(persisted.deleteExpired('2026-07-31T12:29:59.999Z')).resolves.toBe(0)
    await expect(persisted.deleteExpired('2026-07-31T12:30:00.000Z')).resolves.toBe(1)
    await reopened.destroy()

    expect((await readFile(filename)).includes(Buffer.from('sensitive-preview-plan'))).toBe(false)
  })
})
