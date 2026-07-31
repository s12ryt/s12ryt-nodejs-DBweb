import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import { ExactCsvExportService, type ExactCsvExportPlan } from './exact-csv-export-service.js'
import { ExactCsvImportService, type ExactCsvImportPlan } from './exact-csv-import-service.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'

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
  ],
  uniqueKeys: [{ name: 'users_pkey', kind: 'primary', columns: ['id'] }],
}
const sidecar: ExactCsvSidecar = {
  format: 'dbweb-exact-csv', version: 1, schema: 'legacy', table: 'users', delimiter: ',', bom: false,
  columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'string' }],
}

describe('exact CSV services', () => {
  it('exports tagged rows through the exact CSV package writer', async () => {
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, now)
    let job = await jobs.create(actor, { connectionId: connection.id, direction: 'export', format: 'csv' })
    job = await jobs.update(actor, job.id, (current) => ({ ...current, status: 'previewed', updatedAt: later() }))
    const captured: unknown[] = []
    const plan: ExactCsvExportPlan = { table, filters: [], delimiter: ';', bom: true, compression: 'gzip' }
    const service = new ExactCsvExportService(
      jobs,
      { resolveConnection: vi.fn().mockResolvedValue(connection) },
      { postgres: { stream: vi.fn(() => rows()) }, mysql: { stream: vi.fn(() => rows()) } },
      { write: vi.fn(async (_id, writtenSidecar, writtenRows) => {
        captured.push(writtenSidecar)
        for await (const row of writtenRows) captured.push(row)
        return { bytes: 120, chunks: 1, checksum: 'a'.repeat(64) }
      }), delete: vi.fn().mockResolvedValue(undefined) },
      { validate: vi.fn().mockResolvedValue(plan) },
      async () => true,
      now,
    )

    await expect(service.execute(actor, job.id, 'token')).resolves.toMatchObject({ bytes: 120 })
    expect(captured).toEqual([
      { ...sidecar, schema: 'public', delimiter: ';', bom: true },
      { id: { kind: 'value', type: 'bigint', value: '1' }, name: { kind: 'value', type: 'string', value: 'Ada' } },
    ])
    expect(await jobs.get(actor, job.id)).toMatchObject({ status: 'succeeded', processedRows: 1, processedTables: 1 })
  })

  it('validates the sidecar, maps rows, and reuses the dialect import gateway', async () => {
    const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, now)
    let job = await jobs.create(actor, { connectionId: connection.id, direction: 'import', format: 'csv' })
    const archive = Buffer.from('encrypted-package-placeholder')
    job = await jobs.update(actor, job.id, (current) => ({
      ...current, status: 'previewed', sourceBytes: archive.length,
      sourceChecksum: createHash('sha256').update(archive).digest('hex'),
      uploadCompletedAt: now().toISOString(), updatedAt: later(),
    }))
    const captured: unknown[] = []
    const plan: ExactCsvImportPlan = {
      compression: 'none', transaction: 'batch', batchSize: 1000, source: sidecar, target: table,
      mapping: {
        mapped: [{ source: 'id', target: 'id', type: 'bigint' }, { source: 'name', target: 'name', type: 'string' }],
        missing: [], ignored: [],
      },
      conflict: { conflict: 'skip', transaction: 'batch', batchSize: 1000, identity: table.uniqueKeys[0]!, preserveIdentity: false, resumed: false },
    }
    const execute = vi.fn(async (_connection, request) => {
      for await (const row of request.rows) captured.push(row)
      return { processedRows: 1, insertedRows: 1, updatedRows: 0, skippedRows: 0, batches: 1 }
    })
    const service = new ExactCsvImportService(
      jobs,
      { resolveConnection: vi.fn().mockResolvedValue(connection) },
      { postgres: { execute }, mysql: { execute } },
      { stream: vi.fn(() => from([archive])) },
      { read: vi.fn(async (_chunks, handler) => handler(sidecar, rows())) },
      { validate: vi.fn().mockResolvedValue(plan) },
      async () => true,
      now,
    )

    await expect(service.execute(actor, job.id, 'token')).resolves.toMatchObject({ insertedRows: 1 })
    expect(captured).toEqual([{ sourceId: 'csv', values: {
      id: { kind: 'value', type: 'bigint', value: '1' },
      name: { kind: 'value', type: 'string', value: 'Ada' },
    } }])
    expect(await jobs.get(actor, job.id)).toMatchObject({ status: 'succeeded', processedRows: 1, processedTables: 1 })
  })
})

function now() { return new Date('2026-07-31T12:00:00.000Z') }
function later() { return '2026-07-31T12:00:00.001Z' }
async function* rows() {
  yield { id: { kind: 'value' as const, type: 'bigint' as const, value: '1' }, name: { kind: 'value' as const, type: 'string' as const, value: 'Ada' } }
}
async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }
