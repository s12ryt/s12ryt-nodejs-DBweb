import { createHash, randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  FriendlyCsvPreviewCoordinator,
  FriendlyCsvPreviewError,
} from './friendly-csv-preview.js'
import {
  MemoryTransferJobRepository,
  TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import {
  EncryptedTransferPreviewPlanStore,
  MemoryTransferPreviewPlanRepository,
} from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'

const actor: AuthUser = {
  id: 'user-1',
  username: 'operator',
  role: 'user',
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

async function setup() {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, () => now)
  const job = await jobs.create(actor, {
    connectionId: connection.id,
    direction: 'export',
    format: 'csv',
  })
  const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 51), () => now)
  const plans = new EncryptedTransferPreviewPlanStore(
    new MemoryTransferPreviewPlanRepository(),
    new EnvelopeEncryption(Buffer.alloc(32, 52)),
    tokens,
    () => now,
  )
  let capabilityHash = hash('data-read:v1')
  let currentTable = structuredClone(table)
  const resolveConnection = vi.fn(async () => connection)
  const describeTable = vi.fn(async () => currentTable)
  const gateway: Pick<DataMutationGateway, 'describeTable'> = { describeTable }
  const authorize = vi.fn(async () => ({ allowed: true, fingerprint: capabilityHash }))
  const coordinator = new FriendlyCsvPreviewCoordinator(
    jobs,
    { resolveConnection },
    { postgres: gateway, mysql: gateway },
    plans,
    authorize,
  )
  return {
    authorize,
    coordinator,
    describeTable,
    job,
    jobs,
    plans,
    resolveConnection,
    setCapabilityHash(value: string) { capabilityHash = value },
    setTable(value: MutationTable) { currentTable = value },
    tokens,
  }
}

describe('FriendlyCsvPreviewCoordinator', () => {
  it('derives a trusted export plan and validates it against current schema and capability state', async () => {
    const { coordinator, job, jobs, plans, tokens } = await setup()
    const request = {
      mapping: {},
      strategy: {
        mode: 'friendly', delimiter: ',', bom: true, rawFormulaValues: false,
      },
      target: {
        schema: 'public',
        table: 'orders',
        filters: [{
          column: 'id',
          operator: 'gte',
          value: { kind: 'value', type: 'bigint', value: '10' },
        }],
      },
    } as const

    const inspection = await coordinator.inspect(actor, job, request)
    const token = tokens.issue(inspection.fingerprint)
    await plans.save(job.id, inspection.fingerprint, inspection.plan)
    await jobs.update(actor, job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    await expect(coordinator.validate(actor, job.id, token)).resolves.toEqual({
      table,
      filters: request.target.filters,
      delimiter: ',',
      bom: true,
      rawFormulaValues: false,
    })
    expect(inspection.fingerprint).toMatchObject({
      jobId: job.id,
      sourceChecksum: hash('dbweb-export-source-v1'),
      capabilityHash: hash('data-read:v1'),
    })
  })

  it('rejects stale tokens after schema or capability changes and checks authorization before decryption', async () => {
    const setupResult = await setup()
    const { coordinator, job, jobs, plans, tokens } = setupResult
    const request = {
      mapping: {},
      strategy: { mode: 'friendly', delimiter: ',', bom: false, rawFormulaValues: false },
      target: { schema: 'public', table: 'orders', filters: [] },
    } as const
    const inspection = await coordinator.inspect(actor, job, request)
    const token = tokens.issue(inspection.fingerprint)
    await plans.save(job.id, inspection.fingerprint, inspection.plan)
    await jobs.update(actor, job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    setupResult.setTable({
      ...table,
      columns: [...table.columns, {
        name: 'created_at', valueType: 'timestamptz', nullable: false, generated: false,
      }],
    })
    await expect(coordinator.validate(actor, job.id, token)).rejects.toEqual(
      new FriendlyCsvPreviewError('PREVIEW_CHANGED'),
    )

    setupResult.setTable(table)
    setupResult.setCapabilityHash(hash('data-read:v2'))
    await expect(coordinator.validate(actor, job.id, token)).rejects.toEqual(
      new FriendlyCsvPreviewError('PREVIEW_CHANGED'),
    )

    const denied = new FriendlyCsvPreviewCoordinator(
      jobs,
      { resolveConnection: vi.fn(async () => connection) },
      { postgres: { describeTable: vi.fn() }, mysql: { describeTable: vi.fn() } },
      plans,
      async () => ({ allowed: false, fingerprint: hash('denied') }),
    )
    await expect(denied.validate(actor, job.id, token)).rejects.toEqual(
      new FriendlyCsvPreviewError('FORBIDDEN'),
    )
  })

  it('rejects client-defined plans, unsupported jobs, and invalid formula confirmation', async () => {
    const { coordinator, job } = await setup()
    await expect(coordinator.inspect(actor, job, {
      mapping: { injected: 'plan' },
      strategy: { mode: 'friendly' },
      target: { schema: 'public', table: 'orders' },
    })).rejects.toEqual(new FriendlyCsvPreviewError('INVALID_PREVIEW'))

    await expect(coordinator.inspect(actor, job, {
      mapping: {},
      strategy: { mode: 'friendly', rawFormulaValues: true },
      target: { schema: 'public', table: 'orders' },
    })).rejects.toEqual(new FriendlyCsvPreviewError('CONFIRMATION_REQUIRED'))

    const importJob = { ...job, id: randomUUID(), direction: 'import' as const }
    await expect(coordinator.inspect(actor, importJob, {
      mapping: {}, strategy: {}, target: {},
    })).rejects.toEqual(new FriendlyCsvPreviewError('INVALID_PREVIEW'))
  })
})
