import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { MemoryTransferPreviewPlanRepository, EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { SqlDumpExportPreviewCoordinator, SqlDumpExportPreviewError } from './sql-dump-export-preview.js'
import type { StoredTransferJob } from './transfer-job.js'

const actor: AuthUser = { id: 'user-1', username: 'admin', role: 'admin', enabled: true, passwordChangeRequired: false }
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const job: StoredTransferJob = {
  id: '11111111-1111-4111-8111-111111111111', ownerId: actor.id, connectionId: connection.id,
  direction: 'export', format: 'sql', includeData: true, status: 'queued', receivedBytes: 0,
  processedBytes: 0, processedRows: 0, processedTables: 0, errorCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z',
}

describe('SqlDumpExportPreviewCoordinator', () => {
  it('stores a server-derived immutable plan and rejects schema drift', async () => {
    let currentObject = 'table:public.orders'
    let currentJob = job
    const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 1), () => new Date('2026-01-01T00:00:00.000Z'))
    const plans = new EncryptedTransferPreviewPlanStore(
      new MemoryTransferPreviewPlanRepository(), new EnvelopeEncryption(Buffer.alloc(32, 2)), tokens,
      () => new Date('2026-01-01T00:00:00.000Z'),
    )
    const catalog = {
      withSnapshot: vi.fn(async (_connection, plan, _signal, consume) => consume({
        manifest: {
          format: 'dbweb-sql-dump', version: 1, engine: 'postgres', serverVersion: '17.5', database: 'app',
          scope: plan.scope, objects: [{
            id: currentObject, kind: 'table', schema: 'public', name: 'orders', dependencies: [],
            createCommands: [{ kind: 'create-table', schema: 'public', name: 'orders', columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }] }],
            dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
          }],
        }, entries: [], rows: 0, tables: 1,
      })),
    }
    const coordinator = new SqlDumpExportPreviewCoordinator(
      { get: vi.fn(async () => currentJob) } as never,
      { resolveConnection: vi.fn(async () => connection) },
      { postgres: catalog, mysql: catalog } as never,
      plans,
      vi.fn(async () => ({ allowed: true, fingerprint: 'a'.repeat(64) })),
    )

    const inspection = await coordinator.inspect(actor, job, {
      mapping: {}, strategy: { compression: 'gzip' },
      target: { scope: { kind: 'table', schema: 'public', table: 'orders' } },
    })
    expect(inspection.plan).toEqual({
      compression: 'gzip', includeData: true,
      scope: { kind: 'table', schema: 'public', table: 'orders' },
    })
    await plans.save(job.id, inspection.fingerprint, inspection.plan)
    const token = tokens.issue(inspection.fingerprint)
    currentJob = { ...job, status: 'previewed' }
    await expect(coordinator.validate(actor, job.id, token)).resolves.toEqual(inspection.plan)
    currentObject = 'table:public.changed'
    await expect(coordinator.validate(actor, job.id, token)).rejects.toEqual(
      new SqlDumpExportPreviewError('PREVIEW_CHANGED'),
    )
  })

  it('authorizes before opening the connection', async () => {
    const resolveConnection = vi.fn()
    const coordinator = new SqlDumpExportPreviewCoordinator(
      { get: vi.fn(async () => ({ ...job, status: 'previewed' })) } as never,
      { resolveConnection }, {} as never, {} as never,
      vi.fn(async () => ({ allowed: false, fingerprint: 'b'.repeat(64) })),
    )
    await expect(coordinator.validate(actor, job.id, 'token')).rejects.toEqual(
      new SqlDumpExportPreviewError('FORBIDDEN'),
    )
    expect(resolveConnection).not.toHaveBeenCalled()
  })
})
