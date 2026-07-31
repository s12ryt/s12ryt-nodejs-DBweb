import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { SqlDumpExportCatalog, SqlDumpExportPlan } from './sql-dump-export-service.js'
import type { SqlDumpScope } from './sql-dump-manifest.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferPreviewPlanError, type EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import type { TransferPreviewFingerprint } from './transfer-preview-token.js'
import type {
  TransferPreviewInspection,
  TransferPreviewInspector,
  TransferPreviewRequest,
} from './transfer-preview-service.js'

type TransferActor = Pick<AuthUser, 'id' | 'role'>

export type SqlDumpExportPreviewErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class SqlDumpExportPreviewError extends Error {
  constructor(readonly code: SqlDumpExportPreviewErrorCode) {
    super(code)
    this.name = 'SqlDumpExportPreviewError'
  }
}

export interface SqlDumpExportCapabilitySnapshot {
  allowed: boolean
  fingerprint: string
}

export type SqlDumpExportAuthorizer = (
  actor: TransferActor,
  job: StoredTransferJob,
) => Promise<SqlDumpExportCapabilitySnapshot>

export class SqlDumpExportPreviewCoordinator implements TransferPreviewInspector {
  constructor(
    private readonly jobs: Pick<TransferJobService, 'get'>,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly catalogs: Record<DatabaseEngine, SqlDumpExportCatalog>,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: SqlDumpExportAuthorizer,
  ) {}

  async inspect(
    actor: TransferActor,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    const access = await this.authorize(actor, job)
    if (!access.allowed) throw new SqlDumpExportPreviewError('FORBIDDEN')
    this.assertJob(job, 'queued')
    const plan = parseRequest(request, job.includeData)
    try {
      const current = await this.buildCurrent(job, plan, access.fingerprint)
      return {
        fingerprint: current.fingerprint,
        estimatedBytes: 0,
        estimatedRows: 0,
        estimatedTables: current.tables,
        issues: [],
        plan,
      }
    } catch (error) {
      if (error instanceof SqlDumpExportPreviewError) throw error
      throw new SqlDumpExportPreviewError('INVALID_PREVIEW')
    }
  }

  async validate(actor: TransferActor, jobId: string, token: string): Promise<SqlDumpExportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const access = await this.authorize(actor, job)
    if (!access.allowed) throw new SqlDumpExportPreviewError('FORBIDDEN')
    this.assertJob(job, 'previewed')
    try {
      const stored = await this.plans.validate(jobId, token, async (plan) => {
        try {
          return (await this.buildCurrent(job, parseStoredPlan(plan, job.includeData), access.fingerprint)).fingerprint
        } catch {
          throw new TransferPreviewPlanError('PREVIEW_CHANGED')
        }
      })
      return parseStoredPlan(stored, job.includeData)
    } catch (error) {
      if (error instanceof TransferPreviewPlanError) {
        if (error.code === 'PREVIEW_CHANGED') throw new SqlDumpExportPreviewError('PREVIEW_CHANGED')
        if (error.code === 'PREVIEW_EXPIRED') throw new SqlDumpExportPreviewError('PREVIEW_EXPIRED')
        if (error.code === 'PREVIEW_NOT_FOUND') throw new SqlDumpExportPreviewError('PREVIEW_NOT_FOUND')
      }
      throw new SqlDumpExportPreviewError('INVALID_PREVIEW')
    }
  }

  private async buildCurrent(
    job: StoredTransferJob,
    plan: SqlDumpExportPlan,
    accessFingerprint: string,
  ): Promise<{ fingerprint: TransferPreviewFingerprint; tables: number }> {
    if (!/^[0-9a-f]{64}$/.test(accessFingerprint)) invalidPreview()
    const connection = await this.connections.resolveConnection(job.connectionId)
    const catalog = await this.catalogs[connection.engine].withSnapshot(
      connection,
      { ...plan, includeData: false },
      new AbortController().signal,
      async (value) => value,
    )
    if (
      catalog.manifest.engine !== connection.engine
      || catalog.manifest.database !== connection.database
      || JSON.stringify(catalog.manifest.scope) !== JSON.stringify(plan.scope)
    ) invalidPreview()
    return {
      tables: catalog.tables,
      fingerprint: {
        jobId: job.id,
        sourceChecksum: hashCanonical('dbweb-export-source-v1'),
        mappingHash: hashCanonical({}),
        strategyHash: hashCanonical({ compression: plan.compression, includeData: plan.includeData }),
        targetHash: hashCanonical({ database: connection.database, scope: plan.scope }),
        capabilityHash: hashCanonical({ accessFingerprint, engine: connection.engine }),
        schemaFingerprint: hashCanonical(catalog.manifest),
      },
    }
  }

  private assertJob(job: StoredTransferJob, status: 'queued' | 'previewed'): void {
    if (job.direction !== 'export' || job.format !== 'sql' || job.status !== status) invalidPreview()
  }
}

function parseRequest(request: TransferPreviewRequest, includeData: boolean): SqlDumpExportPlan {
  if (!plain(request.mapping) || Object.keys(request.mapping).length !== 0 || !plain(request.strategy) || !plain(request.target)) {
    invalidPreview()
  }
  onlyKeys(request.strategy, ['compression'])
  onlyKeys(request.target, ['scope'])
  const compression = request.strategy.compression ?? 'gzip'
  if (compression !== 'none' && compression !== 'gzip') invalidPreview()
  return { compression, scope: parseScope(request.target.scope), includeData }
}

function parseStoredPlan(value: unknown, includeData: boolean): SqlDumpExportPlan {
  if (!plain(value)) invalidPreview()
  onlyKeys(value, ['compression', 'scope', 'includeData'])
  if ((value.compression !== 'none' && value.compression !== 'gzip') || value.includeData !== includeData) invalidPreview()
  return { compression: value.compression, scope: parseScope(value.scope), includeData }
}

function parseScope(value: unknown): SqlDumpScope {
  if (!plain(value) || typeof value.kind !== 'string') invalidPreview()
  if (value.kind === 'database' && Object.keys(value).length === 1) return { kind: 'database' }
  if (value.kind === 'schema' && onlyStringKeys(value, ['kind', 'schema'])) {
    return { kind: 'schema', schema: value.schema as string }
  }
  if (value.kind === 'table' && onlyStringKeys(value, ['kind', 'schema', 'table'])) {
    return { kind: 'table', schema: value.schema as string, table: value.table as string }
  }
  invalidPreview()
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!plain(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function onlyStringKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => typeof value[key] === 'string' && (value[key] as string).trim().length > 0)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidPreview()
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function invalidPreview(): never {
  throw new SqlDumpExportPreviewError('INVALID_PREVIEW')
}
