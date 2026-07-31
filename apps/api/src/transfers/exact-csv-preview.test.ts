import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import {
  ExactCsvExportPreviewCoordinator,
  ExactCsvImportPreviewCoordinator,
  ExactCsvPreviewError,
} from './exact-csv-preview.js'
import { MemoryTransferJobRepository, TransferJobService, transitionTransferJob } from './transfer-job.js'
import { EncryptedTransferPreviewPlanStore, MemoryTransferPreviewPlanRepository } from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const table: MutationTable = {
  schema: 'public', name: 'users',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: false },
    { name: 'name', valueType: 'string', nullable: false, generated: false },
  ], uniqueKeys: [{ name: 'users_pkey', kind: 'primary', columns: ['id'] }],
}
const source: ExactCsvSidecar = {
  format: 'dbweb-exact-csv', version: 1, schema: 'legacy', table: 'users', delimiter: ';', bom: true,
  columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'string' }],
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe('exact CSV preview coordinators', () => {
  it('builds and revalidates a server-derived export plan', async () => {
    const setup = await createSetup('export')
    const coordinator = new ExactCsvExportPreviewCoordinator(
      setup.jobs, setup.connections, setup.gateways, setup.plans,
      async () => ({ allowed: true, fingerprint: hash('data-read:v1') }),
    )
    const request = {
      mapping: {}, strategy: { mode: 'exact', delimiter: ';', bom: true, compression: 'gzip' },
      target: { schema: 'public', table: 'users', filters: [] },
    }

    const inspection = await coordinator.inspect(actor, setup.job, request)
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', { updatedAt: later() }))

    await expect(coordinator.validate(actor, setup.job.id, token)).resolves.toMatchObject({
      table, delimiter: ';', bom: true, compression: 'gzip', filters: [],
    })
    setup.setTable({ ...table, columns: [...table.columns, { name: 'changed', valueType: 'string', nullable: true, generated: false }] })
    await expect(coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(new ExactCsvPreviewError('PREVIEW_CHANGED'))
  })

  it('builds an immutable import mapping and detects source or target drift', async () => {
    const setup = await createSetup('import')
    const read = vi.fn(async (_chunks, handler) => handler(source, emptyRows()))
    const coordinator = new ExactCsvImportPreviewCoordinator(
      setup.jobs, setup.connections, setup.gateways,
      { stream: vi.fn(() => from([Buffer.from('package')])) }, { read }, setup.plans,
      async () => ({ allowed: true, fingerprint: hash('data-write:v1') }),
    )
    const request = {
      mapping: { columns: [{ source: 'id', target: 'id' }, { source: 'name', target: 'name' }] },
      strategy: { mode: 'exact', compression: 'none', transaction: 'batch', batchSize: 1000, conflict: 'update' },
      target: { schema: 'public', table: 'users' },
    }

    const inspection = await coordinator.inspect(actor, setup.job, request)
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', { updatedAt: later() }))

    await expect(coordinator.validate(actor, setup.job.id, token)).resolves.toMatchObject({
      source, target: table, transaction: 'batch', batchSize: 1000,
      conflict: { conflict: 'update' },
    })
    read.mockImplementation(async (_chunks, handler) => handler({ ...source, table: 'changed' }, emptyRows()))
    await expect(coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(new ExactCsvPreviewError('PREVIEW_CHANGED'))
  })
})

async function createSetup(direction: 'import' | 'export') {
  const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, now)
  let job = await jobs.create(actor, { connectionId: connection.id, direction, format: 'csv' })
  if (direction === 'import') job = await jobs.update(actor, job.id, (current) => ({
    ...current, sourceBytes: 7, sourceChecksum: hash('package'), uploadCompletedAt: now().toISOString(), updatedAt: later(),
  }))
  const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 91), now)
  const plans = new EncryptedTransferPreviewPlanStore(
    new MemoryTransferPreviewPlanRepository(), new EnvelopeEncryption(Buffer.alloc(32, 92)), tokens, now,
  )
  let current = table
  const describeTable = vi.fn(async () => structuredClone(current))
  return {
    job, jobs, plans, tokens,
    connections: { resolveConnection: vi.fn().mockResolvedValue(connection) },
    gateways: { postgres: { describeTable }, mysql: { describeTable } },
    setTable(value: MutationTable) { current = value },
  }
}

function now() { return new Date('2026-07-31T12:00:00.000Z') }
function later() { return '2026-07-31T12:00:00.001Z' }
async function* emptyRows() { /* no rows needed for preview */ }
async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }
