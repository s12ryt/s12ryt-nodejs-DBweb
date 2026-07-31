import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'
import {
  ExactJsonExportError,
  ExactJsonExportService,
  type ExactJsonExportPlan,
} from './exact-json-export-service.js'

const actor: AuthUser = { id: 'user-1', username: 'admin', role: 'admin', enabled: true, passwordChangeRequired: false }
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const users: MutationTable = {
  schema: 'public', name: 'users',
  columns: [{ name: 'id', valueType: 'bigint', nullable: false, generated: false }],
  uniqueKeys: [{ name: 'users_pkey', kind: 'primary', columns: ['id'] }],
}
const orders: MutationTable = {
  schema: 'sales', name: 'orders',
  columns: [{ name: 'total', valueType: 'decimal', nullable: false, generated: false }],
  uniqueKeys: [],
}
const plan: ExactJsonExportPlan = {
  compression: 'gzip',
  tables: [
    { id: 'users', table: users, filters: [], includeData: true },
    { id: 'orders', table: orders, filters: [], includeData: true },
  ],
}

describe('ExactJsonExportService', () => {
  it('streams all tables through one snapshot and completes an exact JSON package', async () => {
    const setup = await createSetup()

    const result = await setup.service.execute(actor, setup.jobId, 'preview-token')

    expect(result).toEqual({ bytes: 512, chunks: 2, checksum: 'a'.repeat(64) })
    expect(setup.streamMany).toHaveBeenCalledOnce()
    expect(setup.streamMany.mock.calls[0]?.[1]).toEqual([
      { id: 'users', request: { table: users, filters: [], batchSize: 1_000, signal: expect.any(AbortSignal) } },
      { id: 'orders', request: { table: orders, filters: [], batchSize: 1_000, signal: expect.any(AbortSignal) } },
    ])
    expect(setup.capturedRecords).toEqual([
      { kind: 'row', table: 'users', values: { id: { kind: 'value', type: 'bigint', value: '1' } } },
      { kind: 'row', table: 'orders', values: { total: { kind: 'value', type: 'decimal', value: '12.30' } } },
    ])
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('succeeded')
    expect(setup.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'export', status: 'success', details: { bytes: 512, checksum: 'a'.repeat(64) },
    }))
  })

  it('cleans the package and marks the job failed when the shared snapshot fails', async () => {
    const setup = await createSetup({ failStream: true })

    await expect(setup.service.execute(actor, setup.jobId, 'preview-token')).rejects.toEqual(
      new ExactJsonExportError('EXPORT_FAILED'),
    )

    expect(setup.packageDelete).toHaveBeenCalledWith(setup.jobId)
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('failed')
  })
})

async function createSetup(options: { failStream?: boolean } = {}) {
  const repository = new MemoryTransferJobRepository()
  const jobs = new TransferJobService(repository, async () => true, () => new Date('2026-01-01T00:00:00.000Z'))
  const job = await jobs.create(actor, { connectionId: connection.id, direction: 'export', format: 'json' })
  await jobs.update(actor, job.id, (current) => ({ ...current, status: 'previewed', updatedAt: '2026-01-01T00:00:01.000Z' }))
  const streamMany = vi.fn((resolvedConnection: ResolvedConnection, requests: unknown[]) => {
    void resolvedConnection
    void requests
    return streamRows(options.failStream)
  })
  const capturedRecords: unknown[] = []
  const packageWrite = vi.fn(async (_id, _manifest, records) => {
    for await (const record of records) capturedRecords.push(record)
    return { bytes: 512, chunks: 2, checksum: 'a'.repeat(64) }
  })
  const packageDelete = vi.fn().mockResolvedValue(undefined)
  const audit = { record: vi.fn().mockResolvedValue(undefined) }
  const service = new ExactJsonExportService(
    jobs,
    { resolveConnection: vi.fn().mockResolvedValue(connection) },
    { postgres: { stream: vi.fn(), streamMany }, mysql: { stream: vi.fn(), streamMany } },
    { write: packageWrite, delete: packageDelete },
    { validate: vi.fn().mockResolvedValue(plan) },
    async () => true,
    () => new Date('2026-01-01T00:00:02.000Z'),
    audit,
  )
  return { service, jobs, jobId: job.id, streamMany, packageWrite, packageDelete, audit, capturedRecords }
}

async function* streamRows(fail = false) {
  yield { id: 'users', row: { id: { kind: 'value' as const, type: 'bigint' as const, value: '1' } } }
  if (fail) throw new Error('driver-secret')
  yield { id: 'orders', row: { total: { kind: 'value' as const, type: 'decimal' as const, value: '12.30' } } }
}
