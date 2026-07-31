import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'
import type { SqlDumpManifest } from './sql-dump-manifest.js'
import type { SqlDumpEntrySource } from './sql-dump-package-writer.js'
import {
  SqlDumpExportError,
  SqlDumpExportService,
  type SqlDumpExportCatalog,
  type SqlDumpExportPlan,
} from './sql-dump-export-service.js'

const actor: AuthUser = {
  id: 'user-1', username: 'admin', role: 'admin', enabled: true, passwordChangeRequired: false,
}
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const plan: SqlDumpExportPlan = {
  compression: 'gzip',
  scope: { kind: 'schema', schema: 'public' },
  includeData: true,
}

describe('SqlDumpExportService', () => {
  it('packages a trusted catalog snapshot and completes the export job', async () => {
    const setup = await createSetup()

    const result = await setup.service.execute(actor, setup.jobId, 'preview-token')

    expect(result).toEqual({ bytes: 2048, chunks: 1, checksum: 'a'.repeat(64) })
    expect(setup.withSnapshot).toHaveBeenCalledWith(
      connection, plan, expect.any(AbortSignal), expect.any(Function),
    )
    expect(setup.snapshotActiveDuringWrite).toBe(true)
    expect(setup.write).toHaveBeenCalledWith(
      setup.jobId,
      expect.objectContaining({ engine: 'postgres', database: 'app', scope: plan.scope }),
      expect.arrayContaining([expect.objectContaining({ path: 'data/public.orders.ndjson' })]),
      { compression: 'gzip', signal: expect.any(AbortSignal) },
    )
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('succeeded')
    expect(setup.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'export', status: 'success', details: { bytes: 2048, checksum: 'a'.repeat(64) },
    }))
  })

  it('cleans partial output and marks the job failed without exposing catalog errors', async () => {
    const setup = await createSetup({ failCatalog: true })

    await expect(setup.service.execute(actor, setup.jobId, 'preview-token')).rejects.toEqual(
      new SqlDumpExportError('EXPORT_FAILED'),
    )

    expect(setup.remove).toHaveBeenCalledWith(setup.jobId)
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('failed')
  })
})

async function createSetup(options: { failCatalog?: boolean } = {}) {
  const repository = new MemoryTransferJobRepository()
  const jobs = new TransferJobService(repository, async () => true, () => new Date('2026-01-01T00:00:00.000Z'))
  const job = await jobs.create(actor, {
    connectionId: connection.id, direction: 'export', format: 'sql', includeData: true,
  })
  await jobs.update(actor, job.id, (current) => ({
    ...current, status: 'previewed', updatedAt: '2026-01-01T00:00:01.000Z',
  }))
  let snapshotActive = false
  let snapshotActiveDuringWrite = false
  const withSnapshot = vi.fn(async (_connection, _plan, _signal, consume) => {
    if (options.failCatalog) throw new Error('catalog-driver-secret')
    snapshotActive = true
    try {
      return await consume({
      manifest: {
        format: 'dbweb-sql-dump' as const,
        version: 1 as const,
        engine: 'postgres' as const,
        serverVersion: '17.5',
        database: 'app',
        scope: plan.scope,
        objects: [{
          id: 'table:public.orders', kind: 'table' as const, schema: 'public', name: 'orders', dependencies: [],
          createCommands: [{
            kind: 'create-table' as const, schema: 'public', name: 'orders',
            columns: [{ name: 'id', type: { name: 'bigint' as const }, nullable: false }],
          }],
          dropCommand: { kind: 'drop-table' as const, schema: 'public', name: 'orders', confirmed: true },
          dataEntry: 'data/public.orders.ndjson',
        }],
      },
      entries: [{
        path: 'data/public.orders.ndjson', objectId: 'table:public.orders', kind: 'data' as const,
        content: oneChunk('row'),
      }],
      rows: 3,
      tables: 1,
      })
    } finally {
      snapshotActive = false
    }
  })
  const write = vi.fn(async (
    outputJobId: string,
    manifestDraft: Omit<SqlDumpManifest, 'entries'>,
    sources: SqlDumpEntrySource[],
  ) => {
    snapshotActiveDuringWrite = snapshotActive
    return {
      jobId: outputJobId,
      manifest: { ...manifestDraft, entries: sources.map((source) => ({
        path: source.path,
        objectId: source.objectId,
        kind: source.kind,
        size: 0,
        sha256: 'b'.repeat(64),
      })) },
      entries: [],
      bytes: 2048,
      chunks: 1,
      checksum: 'a'.repeat(64),
    }
  })
  const remove = vi.fn().mockResolvedValue(undefined)
  const audit = { record: vi.fn().mockResolvedValue(undefined) }
  const service = new SqlDumpExportService(
    jobs,
    { resolveConnection: vi.fn().mockResolvedValue(connection) },
    {
      postgres: { withSnapshot } as unknown as SqlDumpExportCatalog,
      mysql: { withSnapshot } as unknown as SqlDumpExportCatalog,
    },
    { write, delete: remove },
    { validate: vi.fn().mockResolvedValue(plan) },
    async () => true,
    () => new Date('2026-01-01T00:00:02.000Z'),
    audit,
  )
  return {
    service, jobs, jobId: job.id, withSnapshot, write, remove, audit,
    get snapshotActiveDuringWrite() { return snapshotActiveDuringWrite },
  }
}

async function* oneChunk(value: string): AsyncIterable<Buffer> {
  yield Buffer.from(value)
}
