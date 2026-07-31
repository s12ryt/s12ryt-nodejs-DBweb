import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import { CsvTransferHandler, CsvTransferHandlerError } from './csv-transfer-handler.js'
import type { StoredTransferJob } from './transfer-job.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
const job: StoredTransferJob = {
  id: '11111111-1111-4111-8111-111111111111', ownerId: actor.id, connectionId: 'connection-1',
  direction: 'export', format: 'csv', includeData: true, status: 'previewed',
  receivedBytes: 0, processedBytes: 0, processedRows: 0, processedTables: 0, errorCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z',
}

describe('CsvTransferHandler', () => {
  it('routes previews and signed execution to the exact or friendly handler', async () => {
    const friendly = handler('friendly')
    const exactExport = handler('exact-export')
    const exactImport = handler('exact-import')
    let current = job
    const plans = { validate: vi.fn(async () => ({ mode: 'exact' })) }
    const csv = new CsvTransferHandler(
      { get: vi.fn(async () => current), cancel: vi.fn(async () => current) },
      plans, friendly, exactExport, exactImport,
    )

    await expect(csv.inspect(actor, current, { mapping: {}, strategy: { mode: 'friendly' }, target: {} })).resolves.toBe('friendly:inspect')
    await expect(csv.inspect(actor, current, { mapping: {}, strategy: { mode: 'exact' }, target: {} })).resolves.toBe('exact-export:inspect')
    await expect(csv.execute(actor, current.id, 'token')).resolves.toBe('exact-export:execute')
    current = { ...current, direction: 'import' }
    await expect(csv.inspect(actor, current, { mapping: {}, strategy: { mode: 'exact' }, target: {} })).resolves.toBe('exact-import:inspect')
    await expect(csv.execute(actor, current.id, 'token')).resolves.toBe('exact-import:execute')
  })

  it('rejects unsupported modes and cancels the active exact handler', async () => {
    const friendly = handler('friendly')
    const exactExport = handler('exact-export')
    let release!: () => void
    exactExport.execute.mockImplementation(async () => new Promise<string>((resolve) => { release = () => resolve('done') }))
    const csv = new CsvTransferHandler(
      { get: vi.fn(async () => job), cancel: vi.fn(async () => job) },
      { validate: vi.fn(async () => ({ mode: 'exact' })) }, friendly, exactExport, handler('exact-import'),
    )

    await expect(csv.inspect(actor, job, { mapping: {}, strategy: { mode: 'unknown' }, target: {} })).rejects.toEqual(
      new CsvTransferHandlerError('UNSUPPORTED_CSV_MODE'),
    )
    const executing = csv.execute(actor, job.id, 'token')
    await vi.waitFor(() => expect(exactExport.execute).toHaveBeenCalled())
    exactExport.cancel.mockImplementation(async () => { release(); return job })
    await csv.cancel(actor, job.id)
    await executing
    expect(exactExport.cancel).toHaveBeenCalledWith(actor, job.id)
    expect(friendly.cancel).not.toHaveBeenCalled()
  })
})

function handler(name: string) {
  return {
    inspect: vi.fn(async () => `${name}:inspect` as never),
    execute: vi.fn(async () => `${name}:execute`),
    cancel: vi.fn(async () => job),
  }
}
