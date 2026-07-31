import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { encodeExactJson, type ExactJsonManifest, type ExactJsonRecord } from './exact-json-format.js'
import {
  ExactJsonImportError,
  ExactJsonImportGatewayError,
  ExactJsonImportService,
  type ExactJsonImportPlan,
} from './exact-json-import-service.js'
import { writeSafeTar } from './safe-tar.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const target: MutationTable = {
  schema: 'public', name: 'members',
  columns: [
    { name: 'member_id', valueType: 'bigint', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
  ],
  uniqueKeys: [{ name: 'members_pkey', kind: 'primary', columns: ['member_id'] }],
}
const plan: ExactJsonImportPlan = {
  compression: 'gzip',
  transaction: 'batch',
  batchSize: 1_000,
  tables: [{
    sourceId: 'users',
    source: { id: 'users', schema: 'public', table: 'users', columns: [{ name: 'id', type: 'bigint' }] },
    target,
    mapping: {
      mapped: [{ source: 'id', target: 'member_id', type: 'bigint' }],
      missing: [{ target: 'note', value: { kind: 'null' } }],
      ignored: [],
    },
    conflict: { conflict: 'skip', transaction: 'batch', batchSize: 1_000, identity: target.uniqueKeys[0]!, preserveIdentity: false, resumed: false },
  }],
}

describe('ExactJsonImportService', () => {
  it('streams, maps, and executes rows from the encrypted source package', async () => {
    const setup = await createSetup()

    const result = await setup.service.execute(actor, setup.jobId, 'preview-token')

    expect(result).toEqual({ processedRows: 1, insertedRows: 1, updatedRows: 0, skippedRows: 0, batches: 1 })
    expect(setup.execute).toHaveBeenCalledOnce()
    expect(setup.execute.mock.calls[0]?.[1]).toMatchObject({ transaction: 'batch', batchSize: 1_000 })
    expect(setup.capturedRows).toEqual([{
      sourceId: 'users',
      values: {
        member_id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
        note: { kind: 'null' },
      },
    }])
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('succeeded')
  })

  it('marks the job failed and never invokes the gateway when the manifest differs from preview', async () => {
    const setup = await createSetup({ wrongManifest: true })

    await expect(setup.service.execute(actor, setup.jobId, 'preview-token')).rejects.toEqual(
      new ExactJsonImportError('IMPORT_FAILED'),
    )
    expect(setup.execute).not.toHaveBeenCalled()
    expect((await setup.jobs.get(actor, setup.jobId)).status).toBe('failed')
  })

  it('persists only committed gateway progress when a batch import fails', async () => {
    const partial = {
      processedRows: 100, insertedRows: 80, updatedRows: 10, skippedRows: 10, batches: 1,
    }
    const setup = await createSetup({ gatewayError: new ExactJsonImportGatewayError('IMPORT_DATA_FAILED', partial) })

    await expect(setup.service.execute(actor, setup.jobId, 'preview-token')).rejects.toEqual(
      new ExactJsonImportError('IMPORT_FAILED'),
    )
    expect(await setup.jobs.get(actor, setup.jobId)).toMatchObject({
      status: 'failed', processedRows: 100, processedTables: 0, errorCount: 1,
    })
  })
})

async function createSetup(options: { wrongManifest?: boolean; gatewayError?: Error } = {}) {
  const repository = new MemoryTransferJobRepository()
  const jobs = new TransferJobService(repository, async () => true, () => new Date('2026-01-01T00:00:00.000Z'))
  let job = await jobs.create(actor, { connectionId: connection.id, direction: 'import', format: 'json' })
  const archive = await packageBytes(options.wrongManifest)
  job = await jobs.update(actor, job.id, (current) => ({
    ...current,
    status: 'previewed',
    sourceBytes: archive.length,
    sourceChecksum: createHash('sha256').update(archive).digest('hex'),
    uploadCompletedAt: '2026-01-01T00:00:00.001Z',
    updatedAt: '2026-01-01T00:00:00.001Z',
  }))
  const capturedRows: unknown[] = []
  const execute = vi.fn(async (_connection, request) => {
    for await (const row of request.rows) capturedRows.push(row)
    if (options.gatewayError) throw options.gatewayError
    return { processedRows: 1, insertedRows: 1, updatedRows: 0, skippedRows: 0, batches: 1 }
  })
  const service = new ExactJsonImportService(
    jobs,
    { resolveConnection: vi.fn().mockResolvedValue(connection) },
    { postgres: { execute }, mysql: { execute } },
    { stream: vi.fn(() => from([archive])) },
    { validate: vi.fn().mockResolvedValue(plan) },
    async () => true,
    () => new Date('2026-01-01T00:00:01.000Z'),
  )
  return { service, jobs, jobId: job.id, execute, capturedRows }
}

async function packageBytes(wrongManifest = false): Promise<Buffer> {
  const manifest: ExactJsonManifest = {
    kind: 'manifest', format: 'dbweb-exact-json', version: 1,
    tables: [{ id: 'users', schema: 'public', table: 'users', columns: [{ name: wrongManifest ? 'other' : 'id', type: 'bigint' }] }],
  }
  const records: ExactJsonRecord[] = [{
    kind: 'row', table: 'users', values: {
      [wrongManifest ? 'other' : 'id']: { kind: 'value', type: 'bigint', value: '9007199254740993' },
    },
  }]
  const data = Buffer.concat(await collect(encodeExactJson(manifest, from(records))))
  return Buffer.concat(await collect(writeSafeTar([{
    path: 'data.ndjson', size: data.length, content: from([data]),
  }], { compression: 'gzip' })))
}

async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}
