import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import {
  buildTransferColumnMapping,
  type TransferColumnMappingInput,
  type TransferColumnMappingPlan,
} from './transfer-column-mapping.js'
import type { ExactJsonTable } from './exact-json-format.js'
import type { ExactJsonImportPlan, ExactJsonImportPreviewValidator } from './exact-json-import-service.js'
import { readExactJsonPackage } from './exact-json-package-reader.js'
import {
  buildTransferImportPlan,
  TransferImportPlanError,
  type TransferConflictStrategy,
  type TransferTransactionMode,
} from './transfer-import-plan.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import { TransferPreviewPlanError, type EncryptedTransferPreviewPlanStore } from './transfer-preview-plan.js'
import type { TransferPreviewFingerprint } from './transfer-preview-token.js'
import type { TransferPreviewInspection, TransferPreviewInspector, TransferPreviewRequest } from './transfer-preview-service.js'

export type ExactJsonImportPreviewErrorCode =
  | 'CONFIRMATION_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class ExactJsonImportPreviewError extends Error {
  constructor(readonly code: ExactJsonImportPreviewErrorCode) {
    super(code)
    this.name = 'ExactJsonImportPreviewError'
  }
}

export interface ExactJsonImportCapabilitySnapshot {
  allowed: boolean
  fingerprint: string
}

export type ExactJsonImportPreviewAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<ExactJsonImportCapabilitySnapshot>

export interface ExactJsonImportSourceStore {
  stream(jobId: string): AsyncIterable<Buffer>
}

interface ParsedImportRequest {
  compression: 'none' | 'gzip'
  transaction: TransferTransactionMode
  batchSize: number
  conflict: TransferConflictStrategy
  preserveIdentity: boolean
  confirmedReplace: boolean
  resumed: boolean
  targets: Array<{
    sourceId: string
    schema: string
    table: string
    columns: TransferColumnMappingInput[]
  }>
}

export class ExactJsonImportPreviewCoordinator
implements TransferPreviewInspector, ExactJsonImportPreviewValidator {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
    private readonly source: ExactJsonImportSourceStore,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: ExactJsonImportPreviewAuthorizer,
  ) {}

  async inspect(
    actor: Pick<AuthUser, 'id' | 'role'>,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new ExactJsonImportPreviewError('FORBIDDEN')
    assertJob(job, 'queued')
    const parsed = parseRequest(request)
    try {
      const manifest = await this.readManifest(job.id, parsed.compression)
      const connection = await this.connections.resolveConnection(job.connectionId)
      const plan = await this.buildPlan(connection, manifest.tables, parsed)
      return {
        fingerprint: buildFingerprint(job, capability.fingerprint, plan),
        estimatedBytes: job.sourceBytes ?? 0,
        estimatedRows: 0,
        estimatedTables: plan.tables.length,
        issues: [],
        plan,
      }
    } catch (error) {
      throw mapError(error)
    }
  }

  async validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<ExactJsonImportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new ExactJsonImportPreviewError('FORBIDDEN')
    assertJob(job, 'previewed')
    try {
      const stored = await this.plans.validate(jobId, token, async (storedPlan) => {
        const parsedPlan = parsePlan(storedPlan)
        const manifest = await this.readManifest(job.id, parsedPlan.compression)
        const connection = await this.connections.resolveConnection(job.connectionId)
        const rebuilt = await this.rebuildPlan(connection, manifest.tables, parsedPlan)
        return buildFingerprint(job, capability.fingerprint, rebuilt)
      })
      return parsePlan(stored)
    } catch (error) {
      throw mapError(error)
    }
  }

  private async readManifest(jobId: string, compression: 'none' | 'gzip') {
    return readExactJsonPackage(
      this.source.stream(jobId),
      async (manifest) => structuredClone(manifest),
      { compression },
    )
  }

  private async buildPlan(
    connection: ResolvedConnection,
    sources: ExactJsonTable[],
    request: ParsedImportRequest,
  ): Promise<ExactJsonImportPlan> {
    if (sources.length !== request.targets.length) invalidPreview()
    const sourceById = new Map(sources.map((table) => [table.id, table]))
    const tables = []
    for (const target of request.targets) {
      const source = sourceById.get(target.sourceId)
      if (!source) invalidPreview()
      const metadata = await this.gateways[connection.engine].describeTable(
        connection, target.schema, target.table,
      )
      const mapping = buildTransferColumnMapping(
        source.columns,
        metadata.columns.map((column) => ({
          name: column.name,
          type: column.valueType === 'unsupported' ? invalidPreview() : column.valueType,
          nullable: column.nullable,
          generated: column.generated,
          hasDefault: column.hasDefault === true,
        })),
        target.columns,
        { allowGeneratedTargets: request.preserveIdentity },
      )
      const conflict = buildTransferImportPlan(metadata, {
        conflict: request.conflict,
        transaction: request.transaction,
        batchSize: request.batchSize,
        preserveIdentity: request.preserveIdentity,
        confirmedReplace: request.confirmedReplace,
        resume: request.resumed,
      })
      tables.push({ sourceId: source.id, source, target: metadata, mapping, conflict })
    }
    return {
      compression: request.compression,
      transaction: request.transaction,
      batchSize: request.batchSize,
      tables,
    }
  }

  private async rebuildPlan(
    connection: ResolvedConnection,
    sources: ExactJsonTable[],
    stored: ExactJsonImportPlan,
  ): Promise<ExactJsonImportPlan> {
    const targets = stored.tables.map((item) => ({
      sourceId: item.sourceId,
      schema: item.target.schema,
      table: item.target.name,
      columns: mappingOverrides(item.mapping),
    }))
    const first = stored.tables[0]
    if (!first) invalidPreview()
    return this.buildPlan(connection, sources, {
      compression: stored.compression,
      transaction: stored.transaction,
      batchSize: stored.batchSize,
      conflict: first.conflict.conflict,
      preserveIdentity: first.conflict.preserveIdentity,
      confirmedReplace: first.conflict.conflict === 'replace',
      resumed: first.conflict.resumed,
      targets,
    })
  }
}

function parseRequest(request: TransferPreviewRequest): ParsedImportRequest {
  if (!isPlainObject(request.mapping) || !isPlainObject(request.strategy) || !isPlainObject(request.target)) invalidPreview()
  assertOnlyKeys(request.mapping, ['tables'])
  assertOnlyKeys(request.strategy, [
    'mode', 'compression', 'transaction', 'batchSize', 'conflict',
    'preserveIdentity', 'confirmedReplace', 'resume',
  ])
  assertOnlyKeys(request.target, ['tables'])
  if (!Array.isArray(request.mapping.tables) || !Array.isArray(request.target.tables)) invalidPreview()
  if (request.strategy.mode !== 'exact') invalidPreview()
  const compression = request.strategy.compression ?? 'none'
  const transaction = request.strategy.transaction ?? 'batch'
  const batchSize = request.strategy.batchSize ?? 1_000
  const conflict = request.strategy.conflict ?? 'skip'
  const preserveIdentity = request.strategy.preserveIdentity ?? false
  const confirmedReplace = request.strategy.confirmedReplace ?? false
  const resumed = request.strategy.resume ?? false
  if (
    !['none', 'gzip'].includes(String(compression))
    || !['atomic', 'batch'].includes(String(transaction))
    || !['skip', 'update', 'replace'].includes(String(conflict))
    || !Number.isSafeInteger(batchSize)
    || typeof preserveIdentity !== 'boolean'
    || typeof confirmedReplace !== 'boolean'
    || typeof resumed !== 'boolean'
  ) invalidPreview()
  const mappings = new Map<string, TransferColumnMappingInput[]>()
  for (const value of request.mapping.tables) {
    if (!isPlainObject(value)) invalidPreview()
    assertOnlyKeys(value, ['sourceId', 'columns'])
    if (typeof value.sourceId !== 'string' || !value.sourceId || mappings.has(value.sourceId) || !Array.isArray(value.columns)) invalidPreview()
    mappings.set(value.sourceId, value.columns.map(parseMapping))
  }
  const ids = new Set<string>()
  const targets = request.target.tables.map((value) => {
    if (!isPlainObject(value)) invalidPreview()
    assertOnlyKeys(value, ['sourceId', 'schema', 'table'])
    if (
      typeof value.sourceId !== 'string' || !value.sourceId || ids.has(value.sourceId)
      || typeof value.schema !== 'string' || !value.schema.trim()
      || typeof value.table !== 'string' || !value.table.trim()
      || !mappings.has(value.sourceId)
    ) invalidPreview()
    ids.add(value.sourceId)
    return {
      sourceId: value.sourceId,
      schema: value.schema.trim(),
      table: value.table.trim(),
      columns: mappings.get(value.sourceId)!,
    }
  })
  if (targets.length === 0 || targets.length > 100 || mappings.size !== targets.length) invalidPreview()
  return {
    compression: compression as 'none' | 'gzip',
    transaction: transaction as TransferTransactionMode,
    batchSize: batchSize as number,
    conflict: conflict as TransferConflictStrategy,
    preserveIdentity,
    confirmedReplace,
    resumed,
    targets,
  }
}

function parseMapping(value: unknown): TransferColumnMappingInput {
  if (!isPlainObject(value)) invalidPreview()
  if (value.ignore === true) {
    assertOnlyKeys(value, ['source', 'ignore'])
    if (typeof value.source !== 'string' || !value.source) invalidPreview()
    return { source: value.source, ignore: true }
  }
  assertOnlyKeys(value, ['source', 'target'])
  if (typeof value.source !== 'string' || !value.source || typeof value.target !== 'string' || !value.target) invalidPreview()
  return { source: value.source, target: value.target }
}

function parsePlan(value: unknown): ExactJsonImportPlan {
  if (!isPlainObject(value) || !Array.isArray(value.tables)) invalidPreview()
  if (!['none', 'gzip'].includes(String(value.compression)) || !['atomic', 'batch'].includes(String(value.transaction))) invalidPreview()
  if (!Number.isSafeInteger(value.batchSize) || value.tables.length === 0 || value.tables.length > 100) invalidPreview()
  for (const item of value.tables) {
    if (
      !isPlainObject(item) || typeof item.sourceId !== 'string'
      || !isPlainObject(item.source) || !isPlainObject(item.target)
      || !isPlainObject(item.mapping) || !isPlainObject(item.conflict)
    ) invalidPreview()
  }
  return structuredClone(value) as unknown as ExactJsonImportPlan
}

function mappingOverrides(plan: TransferColumnMappingPlan): TransferColumnMappingInput[] {
  return [
    ...plan.mapped.map((item) => ({ source: item.source, target: item.target } as const)),
    ...plan.ignored.map((source) => ({ source, ignore: true as const })),
  ]
}

function buildFingerprint(
  job: StoredTransferJob,
  capabilityHash: string,
  plan: ExactJsonImportPlan,
): TransferPreviewFingerprint {
  if (!job.sourceChecksum || !/^[0-9a-f]{64}$/.test(capabilityHash)) invalidPreview()
  return {
    jobId: job.id,
    sourceChecksum: job.sourceChecksum,
    mappingHash: hashCanonical(plan.tables.map((item) => ({ sourceId: item.sourceId, mapping: item.mapping }))),
    strategyHash: hashCanonical({
      compression: plan.compression, transaction: plan.transaction, batchSize: plan.batchSize,
      conflicts: plan.tables.map((item) => item.conflict),
    }),
    targetHash: hashCanonical(plan.tables.map((item) => ({
      sourceId: item.sourceId, schema: item.target.schema, table: item.target.name,
    }))),
    capabilityHash,
    schemaFingerprint: hashCanonical(plan.tables.map((item) => ({
      source: item.source, target: item.target,
    }))),
  }
}

function assertJob(job: StoredTransferJob, status: 'queued' | 'previewed'): void {
  if (
    job.direction !== 'import' || job.format !== 'json' || job.status !== status
    || !job.uploadCompletedAt || !job.sourceChecksum
  ) invalidPreview()
}

function mapError(error: unknown): ExactJsonImportPreviewError {
  if (error instanceof ExactJsonImportPreviewError) return error
  if (error instanceof TransferImportPlanError && error.code === 'REPLACE_CONFIRMATION_REQUIRED') {
    return new ExactJsonImportPreviewError('CONFIRMATION_REQUIRED')
  }
  if (error instanceof TransferPreviewPlanError) {
    if (error.code === 'PREVIEW_CHANGED') return new ExactJsonImportPreviewError('PREVIEW_CHANGED')
    if (error.code === 'PREVIEW_EXPIRED') return new ExactJsonImportPreviewError('PREVIEW_EXPIRED')
    if (error.code === 'PREVIEW_NOT_FOUND') return new ExactJsonImportPreviewError('PREVIEW_NOT_FOUND')
  }
  return new ExactJsonImportPreviewError('INVALID_PREVIEW')
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
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
  throw new ExactJsonImportPreviewError('INVALID_PREVIEW')
}
