import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { ExactJsonPreviewCoordinator, ExactJsonPreviewError } from './exact-json-preview.js'
import { MemoryTransferJobRepository, TransferJobService, transitionTransferJob } from './transfer-job.js'
import { EncryptedTransferPreviewPlanStore, MemoryTransferPreviewPlanRepository } from './transfer-preview-plan.js'
import { TransferPreviewTokenService } from './transfer-preview-token.js'

const actor: AuthUser = { id: 'user-1', username: 'operator', role: 'user', enabled: true, passwordChangeRequired: false }
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe('ExactJsonPreviewCoordinator', () => {
  it('builds and revalidates a server-derived multi-table exact JSON plan', async () => {
    const setup = await createSetup()
    const request = {
      mapping: {},
      strategy: { mode: 'exact', compression: 'gzip' },
      target: { tables: [
        { id: 'users', schema: 'public', table: 'users', includeData: true, filters: [] },
        { id: 'orders', schema: 'sales', table: 'orders', includeData: false, filters: [] },
      ] },
    } as const

    const inspection = await setup.coordinator.inspect(actor, setup.job, request)
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    await expect(setup.coordinator.validate(actor, setup.job.id, token)).resolves.toEqual({
      compression: 'gzip',
      tables: [
        { id: 'users', table: users, includeData: true, filters: [] },
        { id: 'orders', table: orders, includeData: false, filters: [] },
      ],
    })
    expect(inspection.estimatedTables).toBe(2)
    expect(inspection.fingerprint).toMatchObject({
      sourceChecksum: hash('dbweb-export-source-v1'),
      capabilityHash: hash('data-read:v1'),
    })
    expect(setup.describeTable).toHaveBeenCalledTimes(4)
  })

  it('rejects schema drift, duplicate table ids, and authorization loss before decryption', async () => {
    const setup = await createSetup()
    const request = {
      mapping: {}, strategy: { mode: 'exact', compression: 'none' },
      target: { tables: [{ id: 'users', schema: 'public', table: 'users', includeData: true, filters: [] }] },
    } as const
    const inspection = await setup.coordinator.inspect(actor, setup.job, request)
    const token = setup.tokens.issue(inspection.fingerprint)
    await setup.plans.save(setup.job.id, inspection.fingerprint, inspection.plan)
    await setup.jobs.update(actor, setup.job.id, (current) => transitionTransferJob(current, 'previewed', {
      updatedAt: '2026-07-31T12:00:00.001Z',
    }))

    setup.setUsers({ ...users, columns: [...users.columns, { name: 'email', valueType: 'string', nullable: false, generated: false }] })
    await expect(setup.coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(
      new ExactJsonPreviewError('PREVIEW_CHANGED'),
    )

    await expect(setup.coordinator.inspect(actor, { ...setup.job, status: 'queued' }, {
      mapping: {}, strategy: { mode: 'exact' }, target: { tables: [
        { id: 'same', schema: 'public', table: 'users' },
        { id: 'same', schema: 'sales', table: 'orders' },
      ] },
    })).rejects.toEqual(new ExactJsonPreviewError('INVALID_PREVIEW'))

    setup.setAllowed(false)
    await expect(setup.coordinator.validate(actor, setup.job.id, token)).rejects.toEqual(
      new ExactJsonPreviewError('FORBIDDEN'),
    )
  })
})

async function createSetup() {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const jobs = new TransferJobService(new MemoryTransferJobRepository(), async () => true, () => now)
  const job = await jobs.create(actor, { connectionId: connection.id, direction: 'export', format: 'json' })
  const tokens = new TransferPreviewTokenService(Buffer.alloc(32, 71), () => now)
  const plans = new EncryptedTransferPreviewPlanStore(
    new MemoryTransferPreviewPlanRepository(), new EnvelopeEncryption(Buffer.alloc(32, 72)), tokens, () => now,
  )
  let currentUsers = users
  let allowed = true
  const describeTable = vi.fn(async (_connection, schema: string, table: string) => {
    void _connection
    if (schema === 'public' && table === 'users') return currentUsers
    if (schema === 'sales' && table === 'orders') return orders
    throw new Error('missing')
  })
  const coordinator = new ExactJsonPreviewCoordinator(
    jobs,
    { resolveConnection: vi.fn().mockResolvedValue(connection) },
    { postgres: { describeTable }, mysql: { describeTable } },
    plans,
    async () => ({ allowed, fingerprint: hash('data-read:v1') }),
  )
  return {
    coordinator, describeTable, job, jobs, plans, tokens,
    setAllowed(value: boolean) { allowed = value },
    setUsers(value: MutationTable) { currentUsers = value },
  }
}
