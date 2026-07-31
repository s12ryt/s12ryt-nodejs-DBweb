import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'
import { MemoryTransferPreviewPlanRepository, EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'
import type { SqlDumpManifest } from './sql-dump-manifest.js'
import {
  SqlRestorePreviewCoordinator,
  SqlRestorePreviewError,
} from './sql-restore-preview.js'

describe('SQL restore preview', () => {
  it('builds and revalidates an immutable drop-and-recreate plan from server state', async () => {
    const setup = await createSetup()
    setup.catalog.listExistingObjectIds.mockResolvedValue(['table:public.orders'])
    const inspection = await setup.coordinator.inspect(setup.actor, setup.job, {
      mapping: {},
      strategy: {
        mode: 'drop-and-recreate',
        confirmationDatabase: 'restore_db',
        skipUnsupported: false,
      },
      target: { database: 'restore_db' },
    })
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(setup.actor, setup.job.id, (job) => ({ ...job, status: 'previewed' }))

    expect(inspection.estimatedTables).toBe(1)
    expect(inspection.plan).toMatchObject({
      targetDatabase: 'restore_db',
      dropObjectIds: ['table:public.orders'],
    })
    await expect(setup.coordinator.validate(setup.actor, setup.job.id, token)).resolves.toMatchObject({
      targetDatabase: 'restore_db',
      dropObjectIds: ['table:public.orders'],
    })
    expect(setup.catalog.serverVersion).toHaveBeenCalledTimes(2)
    expect(setup.catalog.listExistingObjectIds).toHaveBeenCalledTimes(2)
  })

  it('rejects authorization loss and target schema drift before returning the plan', async () => {
    const setup = await createSetup()
    const inspection = await setup.coordinator.inspect(setup.actor, setup.job, {
      mapping: {}, strategy: { mode: 'stop' }, target: { database: 'restore_db' },
    })
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(setup.actor, setup.job.id, (job) => ({ ...job, status: 'previewed' }))
    setup.catalog.listExistingObjectIds.mockResolvedValueOnce(['table:public.orders'])

    await expect(setup.coordinator.validate(setup.actor, setup.job.id, token)).rejects.toEqual(
      new SqlRestorePreviewError('PREVIEW_CHANGED'),
    )
    setup.allowed = false
    await expect(setup.coordinator.validate(setup.actor, setup.job.id, token)).rejects.toEqual(
      new SqlRestorePreviewError('FORBIDDEN'),
    )
  })

  it('rejects cross-engine packages and client supplied mapping keys', async () => {
    const setup = await createSetup()
    setup.manifest.engine = 'mysql'
    await expect(setup.coordinator.inspect(setup.actor, setup.job, {
      mapping: {}, strategy: { mode: 'stop' }, target: { database: 'restore_db' },
    })).rejects.toEqual(new SqlRestorePreviewError('INVALID_PREVIEW'))
    setup.manifest.engine = 'postgres'
    await expect(setup.coordinator.inspect(setup.actor, setup.job, {
      mapping: { sql: 'DROP DATABASE app' }, strategy: { mode: 'stop' }, target: { database: 'restore_db' },
    })).rejects.toEqual(new SqlRestorePreviewError('INVALID_PREVIEW'))
  })
})

async function createSetup() {
  const now = new Date('2026-07-31T00:00:00.000Z')
  const actor = { id: 'admin-1', role: 'admin' as const }
  const repository = new MemoryTransferJobRepository()
  const jobs = new TransferJobService(repository, async () => true, () => now)
  const job = await jobs.create(actor, { connectionId: 'c1', direction: 'import', format: 'sql' })
  await jobs.update(actor, job.id, (current) => ({
    ...current,
    sourceBytes: 10,
    sourceChecksum: hash('package'),
    uploadCompletedAt: now.toISOString(),
  }))
  const storedJob = await jobs.get(actor, job.id)
  const manifest = manifestFixture()
  const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 4), () => now)
  const plans = new EncryptedTransferPreviewPlanStore(
    new MemoryTransferPreviewPlanRepository(),
    new EnvelopeEncryption(Buffer.alloc(32, 5)),
    tokens,
    () => now,
  )
  const catalog = {
    serverVersion: vi.fn(async () => '17.5'),
    listExistingObjectIds: vi.fn(async () => [] as string[]),
  }
  let allowed = true
  const coordinator = new SqlRestorePreviewCoordinator(
    jobs,
    { resolveConnection: vi.fn(async () => ({ engine: 'postgres', database: 'source' })) } as never,
    { readManifest: vi.fn(async () => structuredClone(manifest)) },
    { postgres: catalog, mysql: catalog },
    plans,
    async () => ({ allowed, fingerprint: hash(allowed ? 'allowed' : 'denied') }),
  )
  return {
    actor,
    jobs,
    job: storedJob,
    manifest,
    catalog,
    plans,
    tokens,
    coordinator,
    get allowed() { return allowed },
    set allowed(value: boolean) { allowed = value },
  }
}

function manifestFixture(): SqlDumpManifest {
  return {
    format: 'dbweb-sql-dump', version: 1, engine: 'postgres', serverVersion: '17.5', database: 'source',
    scope: { kind: 'table', schema: 'public', table: 'orders' }, entries: [],
    objects: [{
      id: 'table:public.orders', kind: 'table', schema: 'public', name: 'orders', dependencies: [],
      createCommands: [{
        kind: 'create-table', schema: 'public', name: 'orders',
        columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
      }],
      dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
    }],
  }
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
