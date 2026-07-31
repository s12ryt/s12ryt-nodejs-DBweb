import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TransferAuditEvent, TransferAuditRecorder } from './transfer-audit.js'
import type { TransferDataGateway } from './transfer-data-gateway.js'
import {
  FriendlyCsvExportError,
  FriendlyCsvExportService,
  type FriendlyCsvExportPlan,
} from './friendly-csv-export-service.js'
import {
  MemoryTransferJobRepository,
  TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'

const actor: AuthUser = {
  id: 'admin-1',
  username: 'admin',
  role: 'admin',
  enabled: true,
  passwordChangeRequired: false,
}

const connection: ResolvedConnection = {
  id: 'connection-1',
  name: 'Primary',
  engine: 'postgres',
  host: 'db.example.test',
  port: 5432,
  database: 'app',
  username: 'dbweb',
  password: 'database-secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

const table: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
  ],
  uniqueKeys: [{ name: 'orders_pkey', kind: 'primary', columns: ['id'] }],
}

const plan: FriendlyCsvExportPlan = {
  table,
  filters: [],
  delimiter: ',',
  bom: false,
  rawFormulaValues: false,
}

async function setup(options: { authorized?: boolean; failStream?: boolean; failAudit?: boolean } = {}) {
  let now = Date.parse('2026-07-31T12:00:00.000Z')
  const repository = new MemoryTransferJobRepository()
  const audit: TransferAuditRecorder & { events: TransferAuditEvent[] } = {
    events: [],
    async record(event) {
      if (options.failAudit && event.action === 'export') throw new Error('audit-secret')
      this.events.push(structuredClone(event))
    },
  }
  const jobs = new TransferJobService(repository, async () => true, () => new Date(now), audit)
  const created = await jobs.create(actor, {
    connectionId: connection.id,
    direction: 'export',
    format: 'csv',
  })
  now += 1
  await jobs.update(actor, created.id, (job) => transitionTransferJob(job, 'previewed', {
    updatedAt: new Date(now).toISOString(),
  }))
  const gateway: TransferDataGateway = {
    stream: vi.fn(() => (async function* () {
      yield {
        id: { kind: 'value', type: 'bigint', value: '1' } as const,
        note: { kind: 'value', type: 'string', value: '=1+1' } as const,
      }
      if (options.failStream) throw new Error('driver-secret')
      yield {
        id: { kind: 'value', type: 'bigint', value: '2' } as const,
        note: { kind: 'null' } as const,
      }
    })()),
  }
  const writer = {
    delete: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(async (_jobId: string, chunks: AsyncIterable<Uint8Array>) => {
      const output: Buffer[] = []
      for await (const chunk of chunks) output.push(Buffer.from(chunk))
      const bytes = Buffer.concat(output)
      return { bytes: bytes.length, chunks: 1, checksum: 'a'.repeat(64) }
    }),
  }
  const preview = { validate: vi.fn().mockResolvedValue(plan) }
  const resolveConnection = vi.fn().mockResolvedValue(connection)
  const authorize = vi.fn().mockResolvedValue(options.authorized ?? true)
  const service = new FriendlyCsvExportService(
    jobs,
    { resolveConnection },
    { postgres: gateway, mysql: gateway },
    writer,
    preview,
    authorize,
    () => new Date(now += 1),
    audit,
  )
  return { audit, authorize, created, gateway, jobs, preview, resolveConnection, service, writer }
}

describe('FriendlyCsvExportService', () => {
  it('validates the preview, streams rows, and completes the export job', async () => {
    const { audit, created, gateway, jobs, preview, service, writer } = await setup()

    const result = await service.execute(actor, created.id, 'signed-preview-token')

    expect(preview.validate).toHaveBeenCalledWith(actor, created.id, 'signed-preview-token')
    expect(gateway.stream).toHaveBeenCalledWith(connection, {
      table,
      filters: [],
      batchSize: 1_000,
      signal: expect.any(AbortSignal),
    })
    const chunks = writer.write.mock.calls[0]?.[1]
    expect(chunks).toBeDefined()
    const completed = await jobs.get(actor, created.id)
    expect(completed).toMatchObject({
      status: 'succeeded',
      processedRows: 2,
      processedTables: 1,
      processedBytes: result.bytes,
    })
    expect(audit.events.at(-1)).toMatchObject({
      action: 'export',
      status: 'success',
      details: { bytes: result.bytes, checksum: 'a'.repeat(64) },
    })
  })

  it('checks current authorization before preview validation or connection decryption', async () => {
    const { authorize, created, preview, resolveConnection, service } = await setup({ authorized: false })

    await expect(service.execute(actor, created.id, 'token')).rejects.toEqual(
      new FriendlyCsvExportError('FORBIDDEN'),
    )
    expect(authorize).toHaveBeenCalledOnce()
    expect(preview.validate).not.toHaveBeenCalled()
    expect(resolveConnection).not.toHaveBeenCalled()
  })

  it('marks the job failed without leaking a driver error or retaining partial success', async () => {
    const { audit, created, jobs, service } = await setup({ failStream: true })

    await expect(service.execute(actor, created.id, 'token')).rejects.toEqual(
      new FriendlyCsvExportError('EXPORT_FAILED'),
    )
    await expect(jobs.get(actor, created.id)).resolves.toMatchObject({ status: 'failed', errorCount: 1 })
    expect(JSON.stringify(audit.events)).not.toContain('driver-secret')
    expect(audit.events.at(-1)).toMatchObject({ action: 'export', status: 'failed' })
  })

  it('deletes completed output and marks the job failed when audit persistence fails', async () => {
    const { created, jobs, service, writer } = await setup({ failAudit: true })

    await expect(service.execute(actor, created.id, 'token')).rejects.toEqual(
      new FriendlyCsvExportError('EXPORT_FAILED'),
    )
    expect(writer.delete).toHaveBeenCalledWith(created.id)
    await expect(jobs.get(actor, created.id)).resolves.toMatchObject({ status: 'failed' })
  })

  it('marks an aborted execution cancelled and removes partial output', async () => {
    const { created, jobs, service, writer } = await setup()
    const controller = new AbortController()
    controller.abort()

    await expect(service.execute(actor, created.id, 'token', controller.signal)).rejects.toEqual(
      new FriendlyCsvExportError('EXPORT_CANCELLED'),
    )
    expect(writer.delete).toHaveBeenCalledWith(created.id)
    await expect(jobs.get(actor, created.id)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('aborts an active export when the owner cancels it', async () => {
    const environment = await setup()
    let signalStarted!: () => void
    const streamStarted = new Promise<void>((resolve) => { signalStarted = resolve })
    const gateway = environment.gateway.stream as ReturnType<typeof vi.fn>
    gateway.mockImplementation((_connection, request: { signal?: AbortSignal }) => (
      async function* () {
        signalStarted()
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        yield {}
      }
    )())

    const execution = environment.service.execute(actor, environment.created.id, 'token')
    await streamStarted
    const cancelled = environment.service.cancel(actor, environment.created.id)

    await expect(execution).rejects.toEqual(new FriendlyCsvExportError('EXPORT_CANCELLED'))
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' })
    expect(environment.writer.delete).toHaveBeenCalledWith(environment.created.id)
  })
})
