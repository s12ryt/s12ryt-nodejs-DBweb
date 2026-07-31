import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { ExactJsonExportPlan, ExactJsonPreviewValidator } from './exact-json-export-service.js'
import {
  buildMysqlTransferFilter,
  buildPostgresTransferFilter,
  type TransferFilter,
} from './transfer-filter.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferPreviewPlanError, type EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import type { TransferPreviewFingerprint } from './transfer-preview-token.js'
import type {
  TransferPreviewInspection,
  TransferPreviewInspector,
  TransferPreviewRequest,
} from './transfer-preview-service.js'

const EXPORT_SOURCE_CHECKSUM = hashValue('dbweb-export-source-v1')

export type ExactJsonPreviewErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class ExactJsonPreviewError extends Error {
  constructor(readonly code: ExactJsonPreviewErrorCode) {
    super(code)
    this.name = 'ExactJsonPreviewError'
  }
}

export interface ExactJsonCapabilitySnapshot {
  allowed: boolean
  fingerprint: string
}

export type ExactJsonPreviewAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<ExactJsonCapabilitySnapshot>

interface ExactJsonTargetTable {
  id: string
  schema: string
  table: string
  includeData: boolean
  filters: TransferFilter[]
}

export class ExactJsonPreviewCoordinator
implements TransferPreviewInspector, ExactJsonPreviewValidator {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: ExactJsonPreviewAuthorizer,
  ) {}

  async inspect(
    actor: Pick<AuthUser, 'id' | 'role'>,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new ExactJsonPreviewError('FORBIDDEN')
    this.assertJob(job)
    const parsed = parseRequest(request)
    const connection = await this.connections.resolveConnection(job.connectionId)
    const plan = await this.buildPlan(
      connection.engine,
      parsed.tables,
      async (schema, table) => this.gateways[connection.engine].describeTable(connection, schema, table),
      parsed.compression,
    )
    return {
      fingerprint: buildFingerprint(job.id, capability.fingerprint, plan),
      estimatedBytes: 0,
      estimatedRows: 0,
      estimatedTables: plan.tables.length,
      issues: [],
      plan,
    }
  }

  async validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<ExactJsonExportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new ExactJsonPreviewError('FORBIDDEN')
    this.assertJob(job, 'previewed')
    try {
      const value = await this.plans.validate(jobId, token, async (storedPlan) => {
        const parsed = parsePlan(storedPlan)
        const connection = await this.connections.resolveConnection(job.connectionId)
        const targets = parsed.tables.map((item) => ({
          id: item.id,
          schema: item.table.schema,
          table: item.table.name,
          includeData: item.includeData,
          filters: item.filters,
        }))
        const current = await this.buildPlan(connection.engine, targets, async (schema, table) =>
          this.gateways[connection.engine].describeTable(connection, schema, table), parsed.compression)
        return buildFingerprint(job.id, capability.fingerprint, current)
      })
      return parsePlan(value)
    } catch (error) {
      if (error instanceof ExactJsonPreviewError) throw error
      if (error instanceof TransferPreviewPlanError) {
        if (error.code === 'PREVIEW_CHANGED') throw new ExactJsonPreviewError('PREVIEW_CHANGED')
        if (error.code === 'PREVIEW_EXPIRED') throw new ExactJsonPreviewError('PREVIEW_EXPIRED')
        if (error.code === 'PREVIEW_NOT_FOUND') throw new ExactJsonPreviewError('PREVIEW_NOT_FOUND')
      }
      throw new ExactJsonPreviewError('INVALID_PREVIEW')
    }
  }

  private async buildPlan(
    engine: DatabaseEngine,
    targets: ExactJsonTargetTable[],
    describe: (schema: string, table: string) => Promise<MutationTable>,
    compression: 'none' | 'gzip' = 'none',
  ): Promise<ExactJsonExportPlan> {
    const tables = []
    for (const target of targets) {
      const table = await describe(target.schema, target.table)
      validateFilters(engine, table, target.filters)
      if (table.columns.some((column) => column.valueType === 'unsupported')) invalidPreview()
      tables.push({
        id: target.id,
        table: structuredClone(table),
        filters: structuredClone(target.filters),
        includeData: target.includeData,
      })
    }
    return { compression, tables }
  }

  private assertJob(job: StoredTransferJob, status: 'queued' | 'previewed' = 'queued'): void {
    if (job.direction !== 'export' || job.format !== 'json' || job.status !== status) invalidPreview()
  }
}

function parseRequest(request: TransferPreviewRequest): {
  compression: 'none' | 'gzip'
  tables: ExactJsonTargetTable[]
} {
  if (!isPlainObject(request.mapping) || Object.keys(request.mapping).length !== 0) invalidPreview()
  if (!isPlainObject(request.strategy) || !isPlainObject(request.target)) invalidPreview()
  assertOnlyKeys(request.strategy, ['mode', 'compression'])
  assertOnlyKeys(request.target, ['tables'])
  if (request.strategy.mode !== 'exact') invalidPreview()
  const compression = request.strategy.compression ?? 'none'
  if (compression !== 'none' && compression !== 'gzip') invalidPreview()
  if (!Array.isArray(request.target.tables) || request.target.tables.length < 1 || request.target.tables.length > 100) {
    invalidPreview()
  }
  const ids = new Set<string>()
  const tables = request.target.tables.map((value) => {
    if (!isPlainObject(value)) invalidPreview()
    assertOnlyKeys(value, ['id', 'schema', 'table', 'includeData', 'filters'])
    const id = value.id
    const schema = value.schema
    const table = value.table
    const includeData = value.includeData ?? true
    const filters = value.filters ?? []
    if (
      typeof id !== 'string' || !id.trim() || ids.has(id)
      || typeof schema !== 'string' || !schema.trim()
      || typeof table !== 'string' || !table.trim()
      || typeof includeData !== 'boolean' || !Array.isArray(filters)
    ) invalidPreview()
    ids.add(id)
    return {
      id,
      schema: schema.trim(),
      table: table.trim(),
      includeData,
      filters: structuredClone(filters) as TransferFilter[],
    }
  })
  return { compression, tables }
}

function parsePlan(value: unknown): ExactJsonExportPlan {
  if (!isPlainObject(value) || !Array.isArray(value.tables)) invalidPreview()
  if (value.compression !== 'none' && value.compression !== 'gzip') invalidPreview()
  const ids = new Set<string>()
  for (const item of value.tables) {
    if (!isPlainObject(item) || !isPlainObject(item.table) || !Array.isArray(item.filters)) invalidPreview()
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.includeData !== 'boolean') invalidPreview()
    const table = item.table as unknown as MutationTable
    if (typeof table.schema !== 'string' || typeof table.name !== 'string' || !Array.isArray(table.columns) || !Array.isArray(table.uniqueKeys)) {
      invalidPreview()
    }
    ids.add(item.id)
  }
  if (ids.size === 0) invalidPreview()
  return structuredClone(value) as unknown as ExactJsonExportPlan
}

function buildFingerprint(
  jobId: string,
  capabilityHash: string,
  plan: ExactJsonExportPlan,
): TransferPreviewFingerprint {
  if (!/^[0-9a-f]{64}$/.test(capabilityHash)) invalidPreview()
  return {
    jobId,
    sourceChecksum: EXPORT_SOURCE_CHECKSUM,
    mappingHash: hashCanonical({}),
    strategyHash: hashCanonical({ mode: 'exact', compression: plan.compression }),
    targetHash: hashCanonical(plan.tables.map((item) => ({
      id: item.id,
      schema: item.table.schema,
      table: item.table.name,
      includeData: item.includeData,
      filters: item.filters,
    }))),
    capabilityHash,
    schemaFingerprint: hashCanonical(plan.tables.map((item) => ({ id: item.id, table: item.table }))),
  }
}

function validateFilters(engine: DatabaseEngine, table: MutationTable, filters: TransferFilter[]): void {
  try {
    if (engine === 'postgres') buildPostgresTransferFilter(table, filters)
    else buildMysqlTransferFilter(table, filters)
  } catch {
    invalidPreview()
  }
}

function hashCanonical(value: unknown): string {
  return hashValue(JSON.stringify(canonicalize(value)))
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalidPreview()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function invalidPreview(): never {
  throw new ExactJsonPreviewError('INVALID_PREVIEW')
}
