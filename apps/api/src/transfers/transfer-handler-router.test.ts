import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import { TransferHandlerRouter, TransferHandlerRouterError } from './transfer-handler-router.js'
import type { StoredTransferJob } from './transfer-job.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
const baseJob: StoredTransferJob = {
  id: '11111111-1111-4111-8111-111111111111', ownerId: actor.id, connectionId: 'connection-1',
  direction: 'export', format: 'csv', includeData: true, status: 'queued',
  receivedBytes: 0, processedBytes: 0, processedRows: 0, processedTables: 0, errorCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z',
}

describe('TransferHandlerRouter', () => {
  it('routes previews and execution by server-side job direction and format', async () => {
    let current = baseJob
    const friendly = handler('friendly')
    const jsonExport = handler('json-export')
    const jsonImport = handler('json-import')
    const sqlExport = handler('sql-export')
    const sqlImport = handler('sql-import')
    const router = new TransferHandlerRouter(
      { get: vi.fn(async () => current), cancel: vi.fn(async () => current) },
      {
        friendlyCsvExport: friendly, exactJsonExport: jsonExport, exactJsonImport: jsonImport,
        sqlDumpExport: sqlExport, sqlRestore: sqlImport,
      },
    )

    await expect(router.inspect(actor, current, { mapping: {}, strategy: {}, target: {} })).resolves.toBe('friendly:inspect')
    current = { ...current, format: 'json', direction: 'export' }
    await expect(router.execute(actor, current.id, 'token')).resolves.toBe('json-export:execute')
    current = { ...current, direction: 'import' }
    await expect(router.cancel(actor, current.id)).resolves.toBe('json-import:cancel')
    current = { ...current, format: 'sql', direction: 'export' }
    await expect(router.inspect(actor, current, { mapping: {}, strategy: {}, target: {} })).resolves.toBe('sql-export:inspect')
    current = { ...current, direction: 'import' }
    await expect(router.execute(actor, current.id, 'token')).resolves.toBe('sql-import:execute')
    expect(friendly.inspect).toHaveBeenCalledOnce()
    expect(jsonExport.execute).toHaveBeenCalledOnce()
    expect(jsonImport.cancel).toHaveBeenCalledOnce()
    expect(sqlExport.inspect).toHaveBeenCalledOnce()
    expect(sqlImport.execute).toHaveBeenCalledOnce()
  })

  it('rejects unsupported combinations without falling back to another handler', async () => {
    const unsupported = { ...baseJob, direction: 'import' as const, format: 'csv' as const }
    const router = new TransferHandlerRouter(
      { get: vi.fn(async () => unsupported), cancel: vi.fn(async () => unsupported) },
      { friendlyCsvExport: handler('friendly'), exactJsonExport: handler('json-export'), exactJsonImport: handler('json-import') },
    )

    await expect(router.execute(actor, unsupported.id, 'token')).rejects.toEqual(
      new TransferHandlerRouterError('UNSUPPORTED_TRANSFER_HANDLER'),
    )
  })
})

function handler(name: string) {
  return {
    inspect: vi.fn(async () => `${name}:inspect` as never),
    execute: vi.fn(async () => `${name}:execute`),
    cancel: vi.fn(async () => `${name}:cancel` as never),
  }
}
