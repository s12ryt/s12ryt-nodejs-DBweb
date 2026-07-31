import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { encodeExactJson, type ExactJsonManifest } from './exact-json-format.js'
import {
  ExactJsonImportPreviewCoordinator,
  ExactJsonImportPreviewError,
} from './exact-json-import-preview.js'
import { writeSafeTar } from './safe-tar.js'
import { MemoryTransferJobRepository, TransferJobService, transitionTransferJob } from './transfer-job.js'
import { EncryptedTransferPreviewPlanStore, MemoryTransferPreviewPlanRepository } from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const target: MutationTable = {
  schema: 'public', name: 'members',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: true, hasDefault: true },
    { name: 'name', valueType: 'string', nullable: false, generated: false, hasDefault: false },
    { name: 'note', valueType: 'string', nullable: false, generated: false, hasDefault: true },
  ],
  uniqueKeys: [{ name: 'members_pkey', kind: 'primary', columns: ['id'] }],
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('ExactJsonImportPreviewCoordinator', () => {
  it('builds an immutable mapping and conflict plan from the uploaded manifest and current schema', async () => {
    const setup = await createSetup()
    const request = previewRequest()

    const inspection = await setup.coordinator.inspect(actor, setup.job, request)
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    await expect(setup.coordinator.validate(actor, setup.job.id, token)).resolves.toMatchObject({
      compression: 'none', transaction: 'batch', batchSize: 1000,
      tables: [{
        sourceId: 'users', source: setup.manifest.tables[0], target,
        mapping: {
          mapped: [
            { source: 'id', target: 'id', type: 'bigint' },
            { source: 'name', target: 'name', type: 'string' },
          ],
          missing: [{ target: 'note', value: { kind: 'default' } }],
          ignored: [],
        },
        conflict: { conflict: 'update', transaction: 'batch', batchSize: 1000, preserveIdentity: true },
      }],
    })
    expect(inspection.fingerprint).toMatchObject({
      sourceChecksum: setup.job.sourceChecksum,
      capabilityHash: hash('data-write:v1'),
    })
  })

  it('rejects authorization loss, source drift, target drift, and unconfirmed replacement', async () => {
    const setup = await createSetup()
    const inspection = await setup.coordinator.inspect(actor, setup.job, previewRequest())
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    setup.setTarget({ ...target, columns: [...target.columns, { name: 'changed', valueType: 'string', nullable: true, generated: false }] })
    await expect(setup.coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(
      new ExactJsonImportPreviewError('PREVIEW_CHANGED'),
    )
    setup.setTarget(target)
    setup.setAllowed(false)
    await expect(setup.coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(
      new ExactJsonImportPreviewError('FORBIDDEN'),
    )
    setup.setAllowed(true)
    await expect(setup.coordinator.inspect(actor, setup.job, {
      ...previewRequest(), strategy: { ...previewRequest().strategy, conflict: 'replace' },
    })).rejects.toEqual(new ExactJsonImportPreviewError('CONFIRMATION_REQUIRED'))
  })
})

function previewRequest() {
  return {
    mapping: { tables: [{ sourceId: 'users', columns: [
      { source: 'id', target: 'id' }, { source: 'name', target: 'name' },
    ] }] },
    strategy: {
      mode: 'exact', compression: 'none', transaction: 'batch', batchSize: 1000,
      conflict: 'update', preserveIdentity: true,
    },
    target: { tables: [{ sourceId: 'users', schema: 'public', table: 'members' }] },
  } as const
}

async function createSetup() {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const manifest: ExactJsonManifest = {
    kind: 'manifest', format: 'dbweb-exact-json', version: 1,
    tables: [{ id: 'users', schema: 'legacy', table: 'users', columns: [
      { name: 'id', type: 'bigint' }, { name: 'name', type: 'string' },
    ] }],
  }
  const ndjson = Buffer.concat(await collect(encodeExactJson(manifest, from([]))))
  const archive = Buffer.concat(await collect(writeSafeTar([{
    path: 'data.ndjson', size: ndjson.length, content: from([ndjson]),
  }])))
  const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, () => now)
  let job = await jobs.create(actor, { connectionId: connection.id, direction: 'import', format: 'json' })
  job = await jobs.update(actor, job.id, (current) => ({
    ...current,
    sourceBytes: archive.length,
    sourceChecksum: hash(archive),
    uploadCompletedAt: now.toISOString(),
    updatedAt: '2026-07-31T12:00:00.001Z',
  }))
  const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 81), () => now)
  const plans = new EncryptedTransferPreviewPlanStore(
    new MemoryTransferPreviewPlanRepository(), new EnvelopeEncryption(Buffer.alloc(32, 82)), tokens, () => now,
  )
  let currentTarget = target
  let allowed = true
  const describeTable = vi.fn(async () => structuredClone(currentTarget))
  const coordinator = new ExactJsonImportPreviewCoordinator(
    jobs,
    { resolveConnection: vi.fn().mockResolvedValue(connection) },
    { postgres: { describeTable }, mysql: { describeTable } },
    { stream: vi.fn(() => from([archive])) },
    plans,
    async () => ({ allowed, fingerprint: hash('data-write:v1') }),
  )
  return {
    coordinator, job, jobs, manifest, plans, tokens,
    setAllowed(value: boolean) { allowed = value },
    setTarget(value: MutationTable) { currentTarget = value },
  }
}

async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}
