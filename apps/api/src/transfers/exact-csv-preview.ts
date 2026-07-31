import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { ExactCsvExportPlan, ExactCsvExportPreviewValidator } from './exact-csv-export-service.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import type {
  ExactCsvImportPlan,
  ExactCsvImportPreviewValidator,
  ExactCsvPackageReader,
} from './exact-csv-import-service.js'
import type { TransferSourcePackageStore } from './exact-json-import-service.js'
import {
  buildTransferColumnMapping,
  type TransferColumnMappingInput,
  type TransferColumnMappingPlan,
} from './transfer-column-mapping.js'
import {
  buildMysqlTransferFilter,
  buildPostgresTransferFilter,
  type TransferFilter,
} from './transfer-filter.js'
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

const EXPORT_SOURCE_CHECKSUM = hashValue('dbweb-export-source-v1')

export type ExactCsvPreviewErrorCode =
  | 'CONFIRMATION_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class ExactCsvPreviewError extends Error {
  constructor(readonly code: ExactCsvPreviewErrorCode) {
    super(code)
    this.name = 'ExactCsvPreviewError'
  }
}

export interface ExactCsvCapabilitySnapshot { allowed: boolean; fingerprint: string }
export type ExactCsvPreviewAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<ExactCsvCapabilitySnapshot>

export class ExactCsvExportPreviewCoordinator
implements TransferPreviewInspector, ExactCsvExportPreviewValidator {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: ExactCsvPreviewAuthorizer,
  ) {}

  async inspect(actor: Pick<AuthUser, 'id' | 'role'>, job: StoredTransferJob, request: TransferPreviewRequest): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) forbidden()
    assertJob(job, 'export', 'queued')
    const parsed = parseExportRequest(request)
    const connection = await this.connections.resolveConnection(job.connectionId)
    const plan = await buildExportPlan(connection, parsed, this.gateways)
    return inspection(job.id, capability.fingerprint, EXPORT_SOURCE_CHECKSUM, plan, 1)
  }

  async validate(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string, token: string): Promise<ExactCsvExportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) forbidden()
    assertJob(job, 'export', 'previewed')
    try {
      const value = await this.plans.validate(jobId, token, async (stored) => {
        const plan = parseExportPlan(stored)
        const connection = await this.connections.resolveConnection(job.connectionId)
        const current = await buildExportPlan(connection, {
          schema: plan.table.schema, table: plan.table.name, filters: plan.filters,
          delimiter: plan.delimiter, bom: plan.bom, compression: plan.compression,
        }, this.gateways)
        return fingerprint(job.id, capability.fingerprint, EXPORT_SOURCE_CHECKSUM, current)
      })
      return parseExportPlan(value)
    } catch (error) { throw mapError(error) }
  }
}

export class ExactCsvImportPreviewCoordinator
implements TransferPreviewInspector, ExactCsvImportPreviewValidator {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
    private readonly source: TransferSourcePackageStore,
    private readonly packages: ExactCsvPackageReader,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: ExactCsvPreviewAuthorizer,
  ) {}

  async inspect(actor: Pick<AuthUser, 'id' | 'role'>, job: StoredTransferJob, request: TransferPreviewRequest): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) forbidden()
    assertJob(job, 'import', 'queued')
    const parsed = parseImportRequest(request)
    try {
      const source = await this.readSidecar(job.id, parsed.compression)
      const connection = await this.connections.resolveConnection(job.connectionId)
      const plan = await buildImportPlan(connection, source, parsed, this.gateways)
      return inspection(job.id, capability.fingerprint, job.sourceChecksum!, plan, 1, job.sourceBytes ?? 0)
    } catch (error) { throw mapError(error) }
  }

  async validate(actor: Pick<AuthUser, 'id' | 'role'>, jobId: string, token: string): Promise<ExactCsvImportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) forbidden()
    assertJob(job, 'import', 'previewed')
    try {
      const value = await this.plans.validate(jobId, token, async (stored) => {
        const plan = parseImportPlan(stored)
        const source = await this.readSidecar(job.id, plan.compression)
        const connection = await this.connections.resolveConnection(job.connectionId)
        const current = await buildImportPlan(connection, source, {
          compression: plan.compression, transaction: plan.transaction, batchSize: plan.batchSize,
          conflict: plan.conflict.conflict, preserveIdentity: plan.conflict.preserveIdentity,
          confirmedReplace: plan.conflict.conflict === 'replace', resumed: plan.conflict.resumed,
          schema: plan.target.schema, table: plan.target.name, columns: mappingOverrides(plan.mapping),
        }, this.gateways)
        return fingerprint(job.id, capability.fingerprint, job.sourceChecksum!, current)
      })
      return parseImportPlan(value)
    } catch (error) { throw mapError(error) }
  }

  private async readSidecar(jobId: string, compression: 'none' | 'gzip'): Promise<ExactCsvSidecar> {
    return this.packages.read(this.source.stream(jobId), async (sidecar) => structuredClone(sidecar), { compression })
  }
}

interface ExportRequest {
  schema: string; table: string; filters: TransferFilter[]
  delimiter: ',' | '\t' | ';'; bom: boolean; compression: 'none' | 'gzip'
}

interface ImportRequest {
  schema: string; table: string; columns: TransferColumnMappingInput[]
  compression: 'none' | 'gzip'; transaction: TransferTransactionMode; batchSize: number
  conflict: TransferConflictStrategy; preserveIdentity: boolean; confirmedReplace: boolean; resumed: boolean
}

async function buildExportPlan(
  connection: ResolvedConnection,
  request: ExportRequest,
  gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
): Promise<ExactCsvExportPlan> {
  const table = await gateways[connection.engine].describeTable(connection, request.schema, request.table)
  if (table.columns.some((column) => column.valueType === 'unsupported')) invalidPreview()
  validateFilters(connection.engine, table, request.filters)
  return { table, filters: structuredClone(request.filters), delimiter: request.delimiter, bom: request.bom, compression: request.compression }
}

async function buildImportPlan(
  connection: ResolvedConnection,
  source: ExactCsvSidecar,
  request: ImportRequest,
  gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
): Promise<ExactCsvImportPlan> {
  const target = await gateways[connection.engine].describeTable(connection, request.schema, request.table)
  const mapping = buildTransferColumnMapping(source.columns, target.columns.map((column) => ({
    name: column.name, type: column.valueType === 'unsupported' ? invalidPreview() : column.valueType,
    nullable: column.nullable, generated: column.generated, hasDefault: column.hasDefault === true,
  })), request.columns, { allowGeneratedTargets: request.preserveIdentity })
  const conflict = buildTransferImportPlan(target, {
    conflict: request.conflict, transaction: request.transaction, batchSize: request.batchSize,
    preserveIdentity: request.preserveIdentity, confirmedReplace: request.confirmedReplace, resume: request.resumed,
  })
  return { compression: request.compression, transaction: request.transaction, batchSize: request.batchSize, source, target, mapping, conflict }
}

function parseExportRequest(request: TransferPreviewRequest): ExportRequest {
  if (!plain(request.mapping) || Object.keys(request.mapping).length !== 0 || !plain(request.strategy) || !plain(request.target)) invalidPreview()
  only(request.strategy, ['mode', 'delimiter', 'bom', 'compression'])
  only(request.target, ['schema', 'table', 'filters'])
  if (request.strategy.mode !== 'exact') invalidPreview()
  const delimiter = request.strategy.delimiter ?? ','
  const bom = request.strategy.bom ?? false
  const compression = request.strategy.compression ?? 'none'
  const filters = request.target.filters ?? []
  if (!([',', '\t', ';'] as unknown[]).includes(delimiter) || typeof bom !== 'boolean' || !['none', 'gzip'].includes(String(compression)) || !Array.isArray(filters)) invalidPreview()
  return { schema: name(request.target.schema), table: name(request.target.table), filters: structuredClone(filters) as TransferFilter[], delimiter: delimiter as ExportRequest['delimiter'], bom, compression: compression as ExportRequest['compression'] }
}

function parseImportRequest(request: TransferPreviewRequest): ImportRequest {
  if (!plain(request.mapping) || !plain(request.strategy) || !plain(request.target)) invalidPreview()
  only(request.mapping, ['columns'])
  only(request.strategy, ['mode', 'compression', 'transaction', 'batchSize', 'conflict', 'preserveIdentity', 'confirmedReplace', 'resume'])
  only(request.target, ['schema', 'table'])
  if (request.strategy.mode !== 'exact' || !Array.isArray(request.mapping.columns)) invalidPreview()
  const compression = request.strategy.compression ?? 'none'
  const transaction = request.strategy.transaction ?? 'batch'
  const batchSize = request.strategy.batchSize ?? 1_000
  const conflict = request.strategy.conflict ?? 'skip'
  const preserveIdentity = request.strategy.preserveIdentity ?? false
  const confirmedReplace = request.strategy.confirmedReplace ?? false
  const resumed = request.strategy.resume ?? false
  if (!['none', 'gzip'].includes(String(compression)) || !['atomic', 'batch'].includes(String(transaction)) || !['skip', 'update', 'replace'].includes(String(conflict)) || !Number.isSafeInteger(batchSize) || typeof preserveIdentity !== 'boolean' || typeof confirmedReplace !== 'boolean' || typeof resumed !== 'boolean') invalidPreview()
  return {
    schema: name(request.target.schema), table: name(request.target.table),
    columns: request.mapping.columns.map(parseMapping), compression: compression as ImportRequest['compression'],
    transaction: transaction as TransferTransactionMode, batchSize: batchSize as number,
    conflict: conflict as TransferConflictStrategy, preserveIdentity, confirmedReplace, resumed,
  }
}

function parseMapping(value: unknown): TransferColumnMappingInput {
  if (!plain(value) || typeof value.source !== 'string' || !value.source) invalidPreview()
  if (value.ignore === true) { only(value, ['source', 'ignore']); return { source: value.source, ignore: true } }
  only(value, ['source', 'target'])
  if (typeof value.target !== 'string' || !value.target) invalidPreview()
  return { source: value.source, target: value.target }
}

function parseExportPlan(value: unknown): ExactCsvExportPlan {
  if (!plain(value) || !plain(value.table) || !Array.isArray(value.filters) || ![',', '\t', ';'].includes(String(value.delimiter)) || typeof value.bom !== 'boolean' || !['none', 'gzip'].includes(String(value.compression))) invalidPreview()
  return structuredClone(value) as unknown as ExactCsvExportPlan
}

function parseImportPlan(value: unknown): ExactCsvImportPlan {
  if (!plain(value) || !plain(value.source) || !plain(value.target) || !plain(value.mapping) || !plain(value.conflict) || !['none', 'gzip'].includes(String(value.compression)) || !['atomic', 'batch'].includes(String(value.transaction)) || !Number.isSafeInteger(value.batchSize)) invalidPreview()
  return structuredClone(value) as unknown as ExactCsvImportPlan
}

function mappingOverrides(plan: TransferColumnMappingPlan): TransferColumnMappingInput[] {
  return [...plan.mapped.map((item) => ({ source: item.source, target: item.target })), ...plan.ignored.map((source) => ({ source, ignore: true as const }))]
}

function inspection(jobId: string, capability: string, source: string, plan: unknown, tables: number, bytes = 0): TransferPreviewInspection {
  return { fingerprint: fingerprint(jobId, capability, source, plan), estimatedBytes: bytes, estimatedRows: 0, estimatedTables: tables, issues: [], plan }
}

function fingerprint(jobId: string, capabilityHash: string, sourceChecksum: string, plan: unknown): TransferPreviewFingerprint {
  if (!/^[0-9a-f]{64}$/.test(capabilityHash) || !/^[0-9a-f]{64}$/.test(sourceChecksum)) invalidPreview()
  const value = plain(plan) ? plan : invalidPreview()
  return {
    jobId, sourceChecksum, capabilityHash,
    mappingHash: hashCanonical('mapping' in value ? value.mapping : {}),
    strategyHash: hashCanonical(value), targetHash: hashCanonical(value), schemaFingerprint: hashCanonical(value),
  }
}

function assertJob(job: StoredTransferJob, direction: 'import' | 'export', status: 'queued' | 'previewed'): void {
  if (job.direction !== direction || job.format !== 'csv' || job.status !== status || (direction === 'import' && (!job.uploadCompletedAt || !job.sourceChecksum))) invalidPreview()
}

function validateFilters(engine: DatabaseEngine, table: MutationTable, filters: TransferFilter[]): void {
  try {
    if (engine === 'postgres') buildPostgresTransferFilter(table, filters)
    else buildMysqlTransferFilter(table, filters)
  } catch {
    invalidPreview()
  }
}

function mapError(error: unknown): ExactCsvPreviewError {
  if (error instanceof ExactCsvPreviewError) return error
  if (error instanceof TransferImportPlanError && error.code === 'REPLACE_CONFIRMATION_REQUIRED') return new ExactCsvPreviewError('CONFIRMATION_REQUIRED')
  if (error instanceof TransferPreviewPlanError) {
    if (error.code === 'PREVIEW_CHANGED') return new ExactCsvPreviewError('PREVIEW_CHANGED')
    if (error.code === 'PREVIEW_EXPIRED') return new ExactCsvPreviewError('PREVIEW_EXPIRED')
    if (error.code === 'PREVIEW_NOT_FOUND') return new ExactCsvPreviewError('PREVIEW_NOT_FOUND')
  }
  return new ExactCsvPreviewError('INVALID_PREVIEW')
}

function hashCanonical(value: unknown): string { return hashValue(JSON.stringify(canonical(value))) }
function hashValue(value: string): string { return createHash('sha256').update(value).digest('hex') }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!plain(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
function name(value: unknown): string { if (typeof value !== 'string' || !value.trim()) invalidPreview(); return value.trim() }
function only(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) invalidPreview() }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
function forbidden(): never { throw new ExactCsvPreviewError('FORBIDDEN') }
function invalidPreview(): never { throw new ExactCsvPreviewError('INVALID_PREVIEW') }
