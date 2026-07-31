import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import type { DdlCapabilities } from '../ddl/ddl-capabilities.js'
import { buildDdlStatements } from '../ddl/ddl-sql-builder.js'
import type { SqlDumpEntry, SqlDumpManifest, SqlDumpObject } from './sql-dump-manifest.js'
import type { SqlRestorePreviewPlan } from './sql-restore-preview.js'
import { TransferJobError, transitionTransferJob, type StoredTransferJob, type TransferJobService } from './transfer-job.js'

type TransferActor = Pick<AuthUser, 'id' | 'role'>

export type SqlRestoreExecutionErrorCode =
  | 'FORBIDDEN' | 'INVALID_RESTORE_JOB' | 'RESTORE_CANCELLED' | 'RESTORE_CHANGED' | 'RESTORE_FAILED'

export class SqlRestoreExecutionError extends Error {
  constructor(
    readonly code: SqlRestoreExecutionErrorCode,
    readonly appliedSteps = 0,
    readonly failedStep?: number,
  ) {
    super(code)
    this.name = 'SqlRestoreExecutionError'
  }
}

export interface SqlRestoreSession {
  transactional: boolean
  capabilities: DdlCapabilities
  begin(): Promise<void>
  executeStatement(sql: string, signal: AbortSignal): Promise<void>
  restoreData(object: SqlDumpObject, entryPath: string, content: AsyncIterable<Buffer>, signal: AbortSignal): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): Promise<void>
  appliedSteps(): number
}

export interface SqlRestoreExecutionGateway {
  open(connection: ResolvedConnection, targetDatabase: string): Promise<SqlRestoreSession>
}

export interface SqlRestorePackageReader {
  read(
    jobId: string,
    handler: (manifest: SqlDumpManifest, entry: SqlDumpEntry, content: AsyncIterable<Buffer>) => Promise<void>,
  ): Promise<SqlDumpManifest>
}

export interface SqlRestorePreviewValidator {
  validate(actor: TransferActor, jobId: string, token: string): Promise<SqlRestorePreviewPlan>
}

export type SqlRestoreExecutionAuthorizer = (actor: TransferActor, job: StoredTransferJob) => Promise<boolean>

export interface SqlRestoreExecutionResult {
  appliedSteps: number
  restoredObjects: number
  restoredEntries: number
}

export class SqlRestoreService {
  private readonly active = new Map<string, {
    actorId: string
    controller: AbortController
    done: Promise<void>
    finish(): void
  }>()

  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly preview: SqlRestorePreviewValidator,
    private readonly packages: SqlRestorePackageReader,
    private readonly gateways: Record<DatabaseEngine, SqlRestoreExecutionGateway>,
    private readonly authorize: SqlRestoreExecutionAuthorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    actor: TransferActor,
    jobId: string,
    previewToken: string,
    externalSignal = new AbortController().signal,
  ): Promise<SqlRestoreExecutionResult> {
    const job = await this.jobs.get(actor, jobId)
    if (!await this.authorize(actor, job)) throw new SqlRestoreExecutionError('FORBIDDEN')
    if (
      job.direction !== 'import' || job.format !== 'sql' || job.status !== 'previewed'
      || !job.uploadCompletedAt || !job.sourceChecksum
    ) throw new SqlRestoreExecutionError('INVALID_RESTORE_JOB')
    const plan = await this.preview.validate(actor, jobId, previewToken)
    const connection = await this.connections.resolveConnection(job.connectionId)
    if (connection.engine !== plan.engine) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
    if (this.active.has(jobId)) throw new SqlRestoreExecutionError('INVALID_RESTORE_JOB')

    const controller = new AbortController()
    const signal = AbortSignal.any([externalSignal, controller.signal])
    const completion = deferred()
    this.active.set(jobId, {
      actorId: actor.id,
      controller,
      done: completion.promise,
      finish: completion.resolve,
    })

    let session: SqlRestoreSession | undefined
    let failedStep: number | undefined
    try {
      const manifest = await this.packages.read(jobId, async () => undefined)
      if (hashCanonical(manifest) !== plan.manifestHash) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
      validatePlanAgainstManifest(plan, manifest)
      session = await this.gateways[connection.engine].open(connection, plan.targetDatabase)
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'running', {
        updatedAt: this.now().toISOString(),
      }))
      await session.begin()

      let sequence = 0
      for (const command of plan.dropCommands) {
        for (const sql of buildDdlStatements(session.capabilities, command)) {
          failedStep = sequence
          assertNotCancelled(signal, session.appliedSteps())
          await session.executeStatement(sql, signal)
          sequence += 1
        }
      }

      sequence = await executeCommandSteps(
        plan.steps.filter((step) => step.phase === 'structure'),
        session,
        signal,
        sequence,
        (index) => { failedStep = index },
      )

      const dataByPath = new Map<string, { object: SqlDumpObject; index: number }>()
      for (const step of plan.steps.filter((candidate) => candidate.phase === 'data')) {
        if (!step.dataEntry) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
        const object = manifest.objects.find((candidate) => candidate.id === step.objectId)
        if (!object) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
        dataByPath.set(step.dataEntry, { object, index: sequence })
        sequence += 1
      }

      await this.packages.read(jobId, async (_manifest, entry, content) => {
        if (entry.kind !== 'data') return
        const data = dataByPath.get(entry.path)
        if (!data || entry.objectId !== data.object.id) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
        failedStep = data.index
        assertNotCancelled(signal, session!.appliedSteps())
        await session!.restoreData(data.object, entry.path, content, signal)
        dataByPath.delete(entry.path)
      })
      if (dataByPath.size > 0) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
      sequence = await executeCommandSteps(
        plan.steps.filter((step) => step.phase === 'dependent'),
        session,
        signal,
        sequence,
        (index) => { failedStep = index },
      )
      await session.commit()
      const result = {
        appliedSteps: session.appliedSteps(),
        restoredObjects: plan.steps.filter((step) => step.phase !== 'data').length,
        restoredEntries: plan.steps.filter((step) => step.phase === 'data').length,
      }
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, 'succeeded', {
        updatedAt: this.now().toISOString(),
        processedBytes: current.processedBytes + (current.sourceBytes ?? 0),
        processedTables: current.processedTables + result.restoredObjects,
      }))
      return result
    } catch (error) {
      const cancelled = signal.aborted
        || (error instanceof SqlRestoreExecutionError && error.code === 'RESTORE_CANCELLED')
      const applied = session?.transactional ? 0 : session?.appliedSteps() ?? 0
      if (session?.transactional) {
        try { await session.rollback() } catch { /* Preserve the safe restore error. */ }
      }
      await this.markStopped(actor, jobId, cancelled ? 'cancelled' : 'failed', applied)
      if (error instanceof SqlRestoreExecutionError && error.code === 'RESTORE_CHANGED') throw error
      throw new SqlRestoreExecutionError(cancelled ? 'RESTORE_CANCELLED' : 'RESTORE_FAILED', applied, failedStep)
    } finally {
      try { await session?.close() } catch { /* Cleanup cannot replace the restore result. */ }
      const active = this.active.get(jobId)
      if (active?.controller === controller) {
        this.active.delete(jobId)
        active.finish()
      }
    }
  }

  async cancel(actor: TransferActor, jobId: string): Promise<void> {
    await this.jobs.get(actor, jobId)
    const active = this.active.get(jobId)
    if (!active || (actor.role !== 'admin' && active.actorId !== actor.id)) {
      await this.jobs.cancel(actor, jobId)
      return
    }
    active.controller.abort(new SqlRestoreExecutionError('RESTORE_CANCELLED'))
    await active.done
  }

  private async markStopped(
    actor: TransferActor,
    jobId: string,
    status: 'failed' | 'cancelled',
    appliedSteps: number,
  ): Promise<void> {
    try {
      await this.jobs.update(actor, jobId, (current) => transitionTransferJob(current, status, {
        updatedAt: this.now().toISOString(),
        processedTables: current.processedTables + appliedSteps,
        ...(status === 'failed' ? { errorCount: current.errorCount + 1 } : {}),
      }))
    } catch (error) {
      if (!(error instanceof TransferJobError)) throw error
    }
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function validatePlanAgainstManifest(plan: SqlRestorePreviewPlan, manifest: SqlDumpManifest): void {
  const objects = new Map(manifest.objects.map((object) => [object.id, object]))
  for (const id of [...plan.dropObjectIds, ...plan.skippedObjectIds]) {
    if (!objects.has(id)) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
  }
  for (const step of plan.steps) {
    const object = objects.get(step.objectId)
    if (!object) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
    if (step.dataEntry) {
      if (object.dataEntry !== step.dataEntry || step.commands.length > 0) {
        throw new SqlRestoreExecutionError('RESTORE_CHANGED')
      }
    } else if (JSON.stringify(step.commands) !== JSON.stringify(object.createCommands)) {
      throw new SqlRestoreExecutionError('RESTORE_CHANGED')
    }
  }
}

async function executeCommandSteps(
  steps: SqlRestorePreviewPlan['steps'],
  session: SqlRestoreSession,
  signal: AbortSignal,
  initialIndex: number,
  onStep: (index: number) => void,
): Promise<number> {
  let index = initialIndex
  for (const step of steps) {
    if (step.dataEntry) throw new SqlRestoreExecutionError('RESTORE_CHANGED')
    for (const command of step.commands) {
      for (const sql of buildDdlStatements(session.capabilities, command)) {
        onStep(index)
        assertNotCancelled(signal, session.appliedSteps())
        await session.executeStatement(sql, signal)
        index += 1
      }
    }
  }
  return index
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonical((value as Record<string, unknown>)[key]),
  ]))
}

function assertNotCancelled(signal: AbortSignal, appliedSteps: number): void {
  if (signal.aborted) throw new SqlRestoreExecutionError('RESTORE_CANCELLED', appliedSteps)
}
