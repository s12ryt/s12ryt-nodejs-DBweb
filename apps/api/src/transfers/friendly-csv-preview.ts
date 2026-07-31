import { createHash } from 'node:crypto'

import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine } from '../connections/connection-types.js'
import type { DataMutationGateway } from '../data/data-mutation-service.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { FriendlyCsvExportPlan, FriendlyCsvPreviewValidator } from './friendly-csv-export-service.js'
import {
  buildMysqlTransferFilter,
  buildPostgresTransferFilter,
  type TransferFilter,
} from './transfer-filter.js'
import type { StoredTransferJob, TransferJobService } from './transfer-job.js'
import {
  TransferPreviewPlanError,
  type EncryptedTransferPreviewPlanStore,
} from './transfer-preview-plan.js'
import type {
  TransferPreviewFingerprint,
} from './transfer-preview-token.js'
import type {
  TransferPreviewInspection,
  TransferPreviewInspector,
  TransferPreviewRequest,
} from './transfer-preview-service.js'

const EXPORT_SOURCE_CHECKSUM = hashValue('dbweb-export-source-v1')

export type FriendlyCsvPreviewErrorCode =
  | 'CONFIRMATION_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_PREVIEW'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class FriendlyCsvPreviewError extends Error {
  constructor(readonly code: FriendlyCsvPreviewErrorCode) {
    super(code)
    this.name = 'FriendlyCsvPreviewError'
  }
}

export interface FriendlyCsvCapabilitySnapshot {
  allowed: boolean
  fingerprint: string
}

export type FriendlyCsvPreviewAuthorizer = (
  actor: Pick<AuthUser, 'id' | 'role'>,
  job: StoredTransferJob,
) => Promise<FriendlyCsvCapabilitySnapshot>

interface FriendlyCsvStrategy {
  mode: 'friendly'
  delimiter: ',' | '\t' | ';'
  bom: boolean
  rawFormulaValues: boolean
  confirmedRawFormulaValues?: boolean
}

interface FriendlyCsvTarget {
  schema: string
  table: string
  filters: TransferFilter[]
}

export class FriendlyCsvPreviewCoordinator
implements TransferPreviewInspector, FriendlyCsvPreviewValidator {
  constructor(
    private readonly jobs: TransferJobService,
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly gateways: Record<DatabaseEngine, Pick<DataMutationGateway, 'describeTable'>>,
    private readonly plans: EncryptedTransferPreviewPlanStore,
    private readonly authorize: FriendlyCsvPreviewAuthorizer,
  ) {}

  async inspect(
    actor: Pick<AuthUser, 'id' | 'role'>,
    job: StoredTransferJob,
    request: TransferPreviewRequest,
  ): Promise<TransferPreviewInspection> {
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new FriendlyCsvPreviewError('FORBIDDEN')
    this.assertJob(job)
    const { strategy, target } = parseRequest(request)
    const connection = await this.connections.resolveConnection(job.connectionId)
    const table = await this.gateways[connection.engine].describeTable(
      connection,
      target.schema,
      target.table,
    )
    validateFilters(connection.engine, table, target.filters)
    const plan = buildPlan(table, target.filters, strategy)

    return {
      fingerprint: buildFingerprint(job.id, capability.fingerprint, plan),
      estimatedBytes: 0,
      estimatedRows: 0,
      estimatedTables: 1,
      issues: [],
      plan,
    }
  }

  async validate(
    actor: Pick<AuthUser, 'id' | 'role'>,
    jobId: string,
    token: string,
  ): Promise<FriendlyCsvExportPlan> {
    const job = await this.jobs.get(actor, jobId)
    const capability = await this.authorize(actor, job)
    if (!capability.allowed) throw new FriendlyCsvPreviewError('FORBIDDEN')
    this.assertJob(job, 'previewed')

    try {
      const plan = await this.plans.validate(jobId, token, async (storedPlan) => {
        const parsed = parsePlan(storedPlan)
        const connection = await this.connections.resolveConnection(job.connectionId)
        const currentTable = await this.gateways[connection.engine].describeTable(
          connection,
          parsed.table.schema,
          parsed.table.name,
        )
        validateFilters(connection.engine, currentTable, parsed.filters)
        return buildFingerprint(job.id, capability.fingerprint, {
          ...parsed,
          table: currentTable,
        })
      })
      return parsePlan(plan)
    } catch (error) {
      if (error instanceof FriendlyCsvPreviewError) throw error
      if (error instanceof TransferPreviewPlanError) {
        if (error.code === 'PREVIEW_CHANGED') {
          throw new FriendlyCsvPreviewError('PREVIEW_CHANGED')
        }
        if (error.code === 'PREVIEW_EXPIRED') {
          throw new FriendlyCsvPreviewError('PREVIEW_EXPIRED')
        }
        if (error.code === 'PREVIEW_NOT_FOUND') {
          throw new FriendlyCsvPreviewError('PREVIEW_NOT_FOUND')
        }
      }
      throw new FriendlyCsvPreviewError('INVALID_PREVIEW')
    }
  }

  private assertJob(job: StoredTransferJob, status: 'queued' | 'previewed' = 'queued'): void {
    if (job.direction !== 'export' || job.format !== 'csv' || job.status !== status) {
      throw new FriendlyCsvPreviewError('INVALID_PREVIEW')
    }
  }
}

function parseRequest(request: TransferPreviewRequest): {
  strategy: FriendlyCsvStrategy
  target: FriendlyCsvTarget
} {
  if (!isPlainObject(request.mapping) || Object.keys(request.mapping).length !== 0) invalidPreview()
  if (!isPlainObject(request.strategy) || !isPlainObject(request.target)) invalidPreview()
  assertOnlyKeys(request.strategy, [
    'mode', 'delimiter', 'bom', 'rawFormulaValues', 'confirmedRawFormulaValues',
  ])
  assertOnlyKeys(request.target, ['schema', 'table', 'filters'])

  const mode = request.strategy.mode
  if (mode !== 'friendly') invalidPreview()
  const delimiter = request.strategy.delimiter ?? ','
  const bom = request.strategy.bom ?? false
  const rawFormulaValues = request.strategy.rawFormulaValues ?? false
  const confirmed = request.strategy.confirmedRawFormulaValues
  if (![',', '\t', ';'].includes(String(delimiter))) invalidPreview()
  if (typeof bom !== 'boolean' || typeof rawFormulaValues !== 'boolean') invalidPreview()
  if (confirmed !== undefined && typeof confirmed !== 'boolean') invalidPreview()
  if (rawFormulaValues && confirmed !== true) {
    throw new FriendlyCsvPreviewError('CONFIRMATION_REQUIRED')
  }

  const schema = request.target.schema
  const table = request.target.table
  const filters = request.target.filters ?? []
  if (
    typeof schema !== 'string'
    || !schema.trim()
    || typeof table !== 'string'
    || !table.trim()
    || !Array.isArray(filters)
  ) invalidPreview()

  return {
    strategy: {
      mode: 'friendly',
      delimiter: delimiter as FriendlyCsvStrategy['delimiter'],
      bom,
      rawFormulaValues,
      ...(confirmed === undefined ? {} : { confirmedRawFormulaValues: confirmed }),
    },
    target: {
      schema: schema.trim(),
      table: table.trim(),
      filters: structuredClone(filters) as TransferFilter[],
    },
  }
}

function buildPlan(
  table: MutationTable,
  filters: TransferFilter[],
  strategy: FriendlyCsvStrategy,
): FriendlyCsvExportPlan {
  return {
    table: structuredClone(table),
    filters: structuredClone(filters),
    delimiter: strategy.delimiter,
    bom: strategy.bom,
    rawFormulaValues: strategy.rawFormulaValues,
    ...(strategy.confirmedRawFormulaValues === undefined
      ? {}
      : { confirmedRawFormulaValues: strategy.confirmedRawFormulaValues }),
  }
}

function buildFingerprint(
  jobId: string,
  capabilityHash: string,
  plan: FriendlyCsvExportPlan,
): TransferPreviewFingerprint {
  if (!/^[0-9a-f]{64}$/.test(capabilityHash)) invalidPreview()
  return {
    jobId,
    sourceChecksum: EXPORT_SOURCE_CHECKSUM,
    mappingHash: hashCanonical({}),
    strategyHash: hashCanonical({
      mode: 'friendly',
      delimiter: plan.delimiter,
      bom: plan.bom,
      rawFormulaValues: plan.rawFormulaValues,
      ...(plan.confirmedRawFormulaValues === undefined
        ? {}
        : { confirmedRawFormulaValues: plan.confirmedRawFormulaValues }),
    }),
    targetHash: hashCanonical({
      schema: plan.table.schema,
      table: plan.table.name,
      filters: plan.filters,
    }),
    capabilityHash,
    schemaFingerprint: hashCanonical(plan.table),
  }
}

function parsePlan(value: unknown): FriendlyCsvExportPlan {
  if (!isPlainObject(value) || !isPlainObject(value.table) || !Array.isArray(value.filters)) {
    invalidPreview()
  }
  const table = value.table as unknown as MutationTable
  if (
    typeof table.schema !== 'string'
    || typeof table.name !== 'string'
    || !Array.isArray(table.columns)
    || !Array.isArray(table.uniqueKeys)
    || ![',', '\t', ';'].includes(String(value.delimiter))
    || typeof value.bom !== 'boolean'
    || typeof value.rawFormulaValues !== 'boolean'
  ) invalidPreview()
  return structuredClone(value) as unknown as FriendlyCsvExportPlan
}

function validateFilters(
  engine: DatabaseEngine,
  table: MutationTable,
  filters: TransferFilter[],
): void {
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
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  )
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
  throw new FriendlyCsvPreviewError('INVALID_PREVIEW')
}
