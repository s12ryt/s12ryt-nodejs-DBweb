import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { detectDdlCapabilities } from '../ddl/ddl-capabilities.js'
import type { SqlDumpManifest } from './sql-dump-manifest.js'
import {
  SqlRestoreExecutionError,
  SqlRestoreService,
  type SqlRestoreSession,
} from './sql-restore-service.js'
import { MemoryTransferJobRepository, TransferJobService } from './transfer-job.js'

describe('SQL restore service', () => {
  it('executes the immutable PostgreSQL plan in one session and commits', async () => {
    const setup = await createSetup('postgres')
    const result = await setup.service.execute(setup.actor, setup.job.id, 'preview-token')

    expect(result).toEqual({ appliedSteps: 5, restoredObjects: 3, restoredEntries: 1 })
    expect(setup.calls).toEqual([
      'begin',
      'sql:DROP TABLE "public"."orders"',
      'sql:CREATE SCHEMA "public"',
      'sql:CREATE TABLE "public"."orders" ("id" bigint NOT NULL)',
      'data:table:public.orders:data/public.orders.ndjson:row-data',
      'sql:CREATE INDEX "orders_id_idx" ON "public"."orders" USING btree ("id")',
      'commit',
      'close',
    ])
    expect((await setup.jobs.get(setup.actor, setup.job.id)).status).toBe('succeeded')
  })

  it('rolls back PostgreSQL and reports no applied steps when a data entry fails', async () => {
    const setup = await createSetup('postgres', { failData: true })

    await expect(setup.service.execute(setup.actor, setup.job.id, 'preview-token')).rejects.toEqual(
      new SqlRestoreExecutionError('RESTORE_FAILED', 0, 3),
    )
    expect(setup.calls).toEqual([
      'begin',
      'sql:DROP TABLE "public"."orders"',
      'sql:CREATE SCHEMA "public"',
      'sql:CREATE TABLE "public"."orders" ("id" bigint NOT NULL)',
      'data:table:public.orders:data/public.orders.ndjson:row-data',
      'rollback',
      'close',
    ])
    expect((await setup.jobs.get(setup.actor, setup.job.id)).status).toBe('failed')
  })

  it('preserves MySQL partial progress and stops before later steps', async () => {
    const setup = await createSetup('mysql', { failSqlAt: 2 })

    await expect(setup.service.execute(setup.actor, setup.job.id, 'preview-token')).rejects.toEqual(
      new SqlRestoreExecutionError('RESTORE_FAILED', 2, 2),
    )
    expect(setup.calls).toEqual([
      'begin',
      'sql:DROP TABLE `public`.`orders`',
      'sql:CREATE DATABASE `public`',
      'sql:CREATE TABLE `public`.`orders` (`id` bigint NOT NULL)',
      'close',
    ])
    expect((await setup.jobs.get(setup.actor, setup.job.id)).processedTables).toBe(2)
  })

  it('rejects a changed package manifest before opening a database session', async () => {
    const setup = await createSetup('postgres', { changedManifest: true })

    await expect(setup.service.execute(setup.actor, setup.job.id, 'preview-token')).rejects.toEqual(
      new SqlRestoreExecutionError('RESTORE_CHANGED', 0),
    )
    expect(setup.openSession).not.toHaveBeenCalled()
  })

  it('aborts an active restore and waits for rollback and session cleanup', async () => {
    const started = deferred<void>()
    const setup = await createSetup('postgres', { waitForCancellation: started })
    const execution = setup.service.execute(setup.actor, setup.job.id, 'preview-token')
    const cancelled = expect(execution).rejects.toEqual(
      new SqlRestoreExecutionError('RESTORE_CANCELLED', 0, 3),
    )
    await started.promise

    await setup.service.cancel(setup.actor, setup.job.id)

    await cancelled
    expect(setup.calls.slice(-3)).toEqual([
      'data:table:public.orders:data/public.orders.ndjson:row-data',
      'rollback',
      'close',
    ])
    expect((await setup.jobs.get(setup.actor, setup.job.id)).status).toBe('cancelled')
  })
})

async function createSetup(
  engine: 'postgres' | 'mysql',
  options: {
    failData?: boolean
    failSqlAt?: number
    changedManifest?: boolean
    waitForCancellation?: Deferred<void>
  } = {},
) {
  const actor = { id: 'admin-1', role: 'admin' as const }
  const now = new Date('2026-07-31T00:00:00.000Z')
  const repository = new MemoryTransferJobRepository()
  const jobs = new TransferJobService(repository, async () => true, () => now)
  const created = await jobs.create(actor, { connectionId: 'c1', direction: 'import', format: 'sql' })
  await jobs.update(actor, created.id, (job) => ({
    ...job,
    status: 'previewed',
    sourceBytes: 8,
    sourceChecksum: hash('package'),
    uploadCompletedAt: now.toISOString(),
  }))
  const job = await jobs.get(actor, created.id)
  const manifest = manifestFixture(engine)
  const plan = {
    engine,
    targetDatabase: 'restore_db',
    mode: 'drop-and-recreate' as const,
    confirmationDatabase: 'restore_db',
    skipUnsupported: false,
    manifestHash: hashCanonical(manifest),
    dropObjectIds: ['table:public.orders'],
    dropCommands: [manifest.objects[1]!.dropCommand],
    skippedObjectIds: [],
    steps: [
      { phase: 'structure' as const, objectId: 'schema:public', commands: manifest.objects[0]!.createCommands },
      { phase: 'structure' as const, objectId: 'table:public.orders', commands: manifest.objects[1]!.createCommands },
      { phase: 'data' as const, objectId: 'table:public.orders', commands: [], dataEntry: 'data/public.orders.ndjson' },
      { phase: 'dependent' as const, objectId: 'index:public.orders.orders_id_idx', commands: manifest.objects[2]!.createCommands },
    ],
  }
  const calls: string[] = []
  let applied = 0
  const session: SqlRestoreSession = {
    transactional: engine === 'postgres',
    capabilities: detectDdlCapabilities(engine, engine === 'postgres' ? '17.5' : '8.4.0'),
    begin: vi.fn(async () => { calls.push('begin') }),
    executeStatement: vi.fn(async (sql) => {
      calls.push(`sql:${sql}`)
      if (options.failSqlAt === applied) throw new Error('driver-secret')
      applied += 1
    }),
    restoreData: vi.fn(async (object, entry, content, signal) => {
      let body = ''
      for await (const chunk of content) body += Buffer.from(chunk).toString('utf8')
      calls.push(`data:${object.id}:${entry}:${body}`)
      if (options.failData) throw new Error('driver-secret')
      if (options.waitForCancellation) {
        options.waitForCancellation.resolve()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      applied += 1
    }),
    commit: vi.fn(async () => { calls.push('commit') }),
    rollback: vi.fn(async () => { calls.push('rollback') }),
    close: vi.fn(async () => { calls.push('close') }),
    appliedSteps: () => applied,
  }
  const openSession = vi.fn(async () => session)
  const service = new SqlRestoreService(
    jobs,
    { resolveConnection: vi.fn(async () => ({ engine, database: 'source_db' })) } as never,
    {
      validate: vi.fn(async () => plan),
    },
    {
      read: vi.fn(async (_jobId, handler) => {
        const actual = structuredClone(manifest)
        if (options.changedManifest) actual.objects[1]!.name = 'changed_orders'
        await handler(actual, actual.entries[0]!, chunks('row-data'))
        return actual
      }),
    },
    { postgres: { open: openSession }, mysql: { open: openSession } },
    async () => true,
    () => now,
  )
  return { actor, jobs, job, service, calls, openSession }
}

function manifestFixture(engine: 'postgres' | 'mysql'): SqlDumpManifest {
  const schema = engine === 'postgres' ? 'public' : 'public'
  const quote = engine === 'postgres' ? '"' : '`'
  const schemaObject = {
    id: 'schema:public', kind: 'schema' as const, schema, name: schema, dependencies: [],
    createCommands: [{ kind: 'create-schema' as const, name: schema }],
    dropCommand: { kind: 'drop-schema' as const, name: schema, confirmed: true },
  }
  const tableObject = {
    id: 'table:public.orders', kind: 'table' as const, schema, name: 'orders', dependencies: ['schema:public'],
    createCommands: [{
      kind: 'create-table' as const, schema, name: 'orders',
      columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
    }],
    dropCommand: { kind: 'drop-table' as const, schema, name: 'orders', confirmed: true },
    dataEntry: 'data/public.orders.ndjson',
  }
  const indexObject = {
    id: 'index:public.orders.orders_id_idx', kind: 'index' as const, schema, name: 'orders_id_idx',
    dependencies: ['table:public.orders'],
    createCommands: [{
      kind: 'create-index' as const, schema, table: 'orders', name: 'orders_id_idx',
      method: 'btree' as const, unique: false, parts: [{ column: 'id' }], confirmed: false,
    }],
    dropCommand: {
      kind: 'drop-index' as const, schema, table: 'orders', name: 'orders_id_idx', confirmed: true,
    },
  }
  void quote
  return {
    format: 'dbweb-sql-dump', version: 1, engine, serverVersion: engine === 'postgres' ? '17.5' : '8.4.0',
    database: 'source_db', scope: { kind: 'database' }, objects: [schemaObject, tableObject, indexObject],
    entries: [{
      path: 'data/public.orders.ndjson', size: 8, sha256: hash('row-data'),
      objectId: tableObject.id, kind: 'data',
    }],
  }
}

async function* chunks(value: string): AsyncIterable<Buffer> {
  yield Buffer.from(value)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonical((value as Record<string, unknown>)[key]),
  ]))
}
