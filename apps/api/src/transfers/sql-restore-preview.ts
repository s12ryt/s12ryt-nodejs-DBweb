import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import { detectDdlCapabilities, type DdlCapabilities } from '../ddl/ddl-capabilities.js'
import { buildDdlStatements } from '../ddl/ddl-sql-builder.js'
import type { SqlDumpManifest, SqlDumpObjectKind } from './sql-dump-manifest.js'
import { validateSqlDumpManifest } from './sql-dump-manifest.js'
import { buildSqlRestorePlan, type SqlRestorePlan } from './sql-restore-plan.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferPreviewPlanError, type EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import type { TransferPreviewFingerprint } from './transfer-preview-token.js'
import type {
  TransferPreviewInspection,
  TransferPreviewInspector,
  TransferPreviewRequest,
} from './transfer-preview-service.js'

export type SqlRestorePreviewErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'
  | 'CONFIRMATION_REQUIRED'

export class SqlRestorePreviewError extends Error {
  constructor(readonly code: SqlRestorePreviewErrorCode) {
    super(code)
    this.name = 'SqlRestorePreviewError'
  }
}

export interface SqlRestoreManifestReader {
  readManifest(jobId: string): Promise<SqlDumpManifest>
}

export interface SqlRestoreCatalogGateway {
  serverVersion(connection: ResolvedConnection, targetDatabase: string): Promise<string>
  listExistingObjectIds(
    connection: ResolvedConnection,
    targetDatabase: string,
    manifest: SqlDumpManifest,
  ): Promise<string[]>
}

export interface SqlRestoreCapabilitySnapshot {
  allowed: boolean
  fingerprint: string
}

export type SqlRestoreAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<SqlRestoreCapabilitySnapshot>

export interface SqlRestorePreviewPlan extends SqlRestorePlan {
  manifestHash: string
  mode: 'stop' | 'drop-and-recreate'
  confirmationDatabase?: string
  skipUnsupported: boolean
}

export class SqlRestorePreviewCoordinator implements TransferPreviewInspector {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly packages: SqlRestoreManifestReader,
    private readonly catalogs: Record<DatabaseEngine, SqlRestoreCatalogGateway>,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: SqlRestoreAuthorizer,
  ) {}

  async inspect(
    actor: Pick<AuthUser, 'id' | 'role'>,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new SqlRestorePreviewError('FORBIDDEN')
    this.assertJob(job, 'queued')
    const strategy = parseRequest(request)
    let current: Awaited<ReturnType<SqlRestorePreviewCoordinator['buildCurrent']>>
    try {
      current = await this.buildCurrent(job, capability.fingerprint, strategy)
    } catch (error) {
      if (error instanceof SqlRestorePreviewError) throw error
      throw new SqlRestorePreviewError('INVALID_PREVIEW')
    }
    return {
      fingerprint: current.fingerprint,
      estimatedBytes: job.sourceBytes ?? 0,
      estimatedRows: 0,
      estimatedTables: current.manifest.objects.filter((object) => object.kind === 'table').length,
      issues: [
        ...current.plan.dropObjectIds.map((objectId) => ({ code: 'RESTORE_DROP', summary: objectId })),
        ...current.plan.skippedObjectIds.map((objectId) => ({ code: 'RESTORE_SKIPPED', summary: objectId })),
      ].slice(0, 100),
      plan: current.plan,
    }
  }

  async validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<SqlRestorePreviewPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new SqlRestorePreviewError('FORBIDDEN')
    this.assertJob(job, 'previewed')
    try {
      const stored = await this.plans.validate(jobId, token, async (plan) => {
        const parsed = parseStoredPlan(plan)
        try {
          const current = await this.buildCurrent(job, capability.fingerprint, {
            mode: parsed.mode,
            ...(parsed.confirmationDatabase ? { confirmationDatabase: parsed.confirmationDatabase } : {}),
            skipUnsupported: parsed.skipUnsupported,
            targetDatabase: parsed.targetDatabase,
          })
          return current.fingerprint
        } catch {
          throw new TransferPreviewPlanError('PREVIEW_CHANGED')
        }
      })
      return parseStoredPlan(stored)
    } catch (error) {
      if (error instanceof SqlRestorePreviewError) throw error
      if (error instanceof TransferPreviewPlanError) {
        if (error.code === 'PREVIEW_CHANGED') throw new SqlRestorePreviewError('PREVIEW_CHANGED')
        if (error.code === 'PREVIEW_EXPIRED') throw new SqlRestorePreviewError('PREVIEW_EXPIRED')
        if (error.code === 'PREVIEW_NOT_FOUND') throw new SqlRestorePreviewError('PREVIEW_NOT_FOUND')
      }
      throw new SqlRestorePreviewError('INVALID_PREVIEW')
    }
  }

  private async buildCurrent(
    job: StoredTransferJob,
    accessFingerprint: string,
    strategy: ParsedRequest,
  ): Promise<{
      manifest: SqlDumpManifest
      plan: SqlRestorePreviewPlan
      fingerprint: TransferPreviewFingerprint
    }> {
    if (!/^[0-9a-f]{64}$/.test(accessFingerprint)) invalidPreview()
    const connection = await this.connections.resolveConnection(job.connectionId)
    const manifest = validateSqlDumpManifest(await this.packages.readManifest(job.id), connection.engine)
    const catalog = this.catalogs[connection.engine]
    const version = await catalog.serverVersion(connection, strategy.targetDatabase)
    const capabilities = detectDdlCapabilities(connection.engine, version)
    const existing = await catalog.listExistingObjectIds(connection, strategy.targetDatabase, manifest)
    const restore = buildSqlRestorePlan(manifest, {
      engine: connection.engine,
      targetDatabase: strategy.targetDatabase,
      existingObjectIds: existing,
      mode: strategy.mode,
      ...(strategy.confirmationDatabase ? { confirmationDatabase: strategy.confirmationDatabase } : {}),
      supportedKinds: supportedKinds(capabilities),
      skipUnsupported: strategy.skipUnsupported,
    })
    validateCommands(capabilities, restore)
    const plan: SqlRestorePreviewPlan = {
      ...restore,
      manifestHash: hashCanonical(manifest),
      mode: strategy.mode,
      ...(strategy.confirmationDatabase ? { confirmationDatabase: strategy.confirmationDatabase } : {}),
      skipUnsupported: strategy.skipUnsupported,
    }
    return {
      manifest,
      plan,
      fingerprint: {
        jobId: job.id,
        sourceChecksum: job.sourceChecksum!,
        mappingHash: hashCanonical({}),
        strategyHash: hashCanonical({
          mode: strategy.mode,
          confirmationDatabase: strategy.confirmationDatabase ?? null,
          skipUnsupported: strategy.skipUnsupported,
        }),
        targetHash: hashCanonical({ database: strategy.targetDatabase }),
        capabilityHash: hashCanonical({ accessFingerprint, capabilities }),
        schemaFingerprint: hashCanonical({ manifest, existing: [...new Set(existing)].sort() }),
      },
    }
  }

  private assertJob(job: StoredTransferJob, status: 'queued' | 'previewed'): void {
    if (
      job.direction !== 'import'
      || job.format !== 'sql'
      || job.status !== status
      || !job.uploadCompletedAt
      || !job.sourceChecksum
    ) invalidPreview()
  }
}

interface ParsedRequest {
  mode: 'stop' | 'drop-and-recreate'
  confirmationDatabase?: string
  skipUnsupported: boolean
  targetDatabase: string
}

function parseRequest(request: TransferPreviewRequest): ParsedRequest {
  if (!plain(request.mapping) || Object.keys(request.mapping).length !== 0 || !plain(request.strategy) || !plain(request.target)) {
    invalidPreview()
  }
  onlyKeys(request.strategy, ['mode', 'confirmationDatabase', 'skipUnsupported'])
  onlyKeys(request.target, ['database'])
  const mode = request.strategy.mode ?? 'stop'
  const skipUnsupported = request.strategy.skipUnsupported ?? false
  const targetDatabase = request.target.database
  const confirmationDatabase = request.strategy.confirmationDatabase
  if (
    (mode !== 'stop' && mode !== 'drop-and-recreate')
    || typeof skipUnsupported !== 'boolean'
    || typeof targetDatabase !== 'string'
    || !targetDatabase.trim()
    || (confirmationDatabase !== undefined && typeof confirmationDatabase !== 'string')
  ) invalidPreview()
  return {
    mode,
    ...(confirmationDatabase ? { confirmationDatabase } : {}),
    skipUnsupported,
    targetDatabase: targetDatabase.trim(),
  }
}

function parseStoredPlan(value: unknown): SqlRestorePreviewPlan {
  if (!plain(value) || !Array.isArray(value.steps) || !Array.isArray(value.dropObjectIds) || !Array.isArray(value.skippedObjectIds)) {
    invalidPreview()
  }
  if (
    (value.engine !== 'postgres' && value.engine !== 'mysql')
    || typeof value.targetDatabase !== 'string'
    || typeof value.manifestHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.manifestHash)
    || (value.mode !== 'stop' && value.mode !== 'drop-and-recreate')
    || typeof value.skipUnsupported !== 'boolean'
  ) invalidPreview()
  return structuredClone(value) as unknown as SqlRestorePreviewPlan
}

function supportedKinds(capabilities: DdlCapabilities): SqlDumpObjectKind[] {
  const kinds: SqlDumpObjectKind[] = ['table', 'index', 'constraint', 'view', 'function', 'trigger', 'partition']
  if (capabilities.engine === 'postgres') kinds.push('schema', 'type', 'domain', 'sequence', 'materialized-view', 'extension')
  if (capabilities.advanced.procedure) kinds.push('procedure')
  if (capabilities.advanced.event) kinds.push('event')
  return kinds
}

function validateCommands(capabilities: DdlCapabilities, plan: SqlRestorePlan): void {
  for (const command of plan.dropCommands) buildDdlStatements(capabilities, command)
  for (const step of plan.steps) {
    for (const command of step.commands) buildDdlStatements(capabilities, command)
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!plain(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidPreview()
}

function invalidPreview(): never {
  throw new SqlRestorePreviewError('INVALID_PREVIEW')
}
