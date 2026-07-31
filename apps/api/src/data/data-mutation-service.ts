import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import {
  buildRowWritePolicy,
  RowWritePolicyError,
  type MutationTable,
} from './row-write-policy.js'
import {
  decodeMutationValue,
  type TaggedDatabaseValue,
} from './tagged-value.js'
import {
  buildMysqlMutation,
  buildPostgresMutation,
  expandMutationOperations,
} from './mutation-sql.js'

export type MutationValues = Record<string, TaggedDatabaseValue>

interface MutationRowReference {
  identity: MutationValues
  original: MutationValues
}

export type DataMutationOperation =
  | { kind: 'insert'; values: MutationValues }
  | ({ kind: 'update'; patch: MutationValues } & MutationRowReference)
  | ({ kind: 'delete'; confirmed?: boolean } & MutationRowReference)
  | { kind: 'batch-update'; rows: MutationRowReference[]; patch: MutationValues }

export interface DataMutationRequest {
  schema: string
  table: string
  operations: DataMutationOperation[]
}

export interface DataMutationResultItem {
  index: number
  affectedRows: number
  insertId?: string
}

export interface DataMutationResult {
  affectedRows: number
  items: DataMutationResultItem[]
}

export interface DataMutationInspection {
  table: MutationTable
  policy: {
    identity: ReturnType<typeof buildRowWritePolicy>['identity']
    writableColumns: string[]
    readOnlyColumns: string[]
    canUpdate: boolean
    canDelete: boolean
  }
}

export interface DataMutationGateway {
  describeTable(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<MutationTable>
  executeTransaction(
    connection: ResolvedConnection,
    request: DataMutationRequest & { metadata: MutationTable },
  ): Promise<DataMutationResult>
}

export interface MutationAuditEntry {
  actorId: string
  connectionId: string
  schema: string
  table: string
  action: 'mutate-rows'
  operationCount: number
  affectedRows: number
  status: 'success' | 'failed'
  sqlTemplates: string[]
  errorCode?: string
  createdAt: string
}

export interface MutationAuditRecorder {
  record(entry: MutationAuditEntry): Promise<void>
}

export type DataMutationErrorCode =
  | 'CONFIRMATION_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_MUTATION'
  | 'MUTATION_FAILED'
  | 'ROW_CONFLICT'
  | 'TABLE_WITHOUT_STABLE_KEY'
  | 'UNSUPPORTED_COLUMN'

export class DataMutationError extends Error {
  constructor(
    readonly code: DataMutationErrorCode,
    readonly operationIndex?: number,
  ) {
    super(code)
    this.name = 'DataMutationError'
  }
}

export class DataMutationService {
  constructor(
    private readonly connections: ConnectionService,
    private readonly gateways: Record<DatabaseEngine, DataMutationGateway>,
    private readonly audit: MutationAuditRecorder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspect(
    actor: { id: string; role: 'admin' | 'user' },
    input: { connectionId: string; schema: string; table: string },
  ): Promise<DataMutationInspection> {
    if (actor.role !== 'admin') throw new DataMutationError('FORBIDDEN')
    if (!input.connectionId.trim() || !input.schema.trim() || !input.table.trim()) {
      throw new DataMutationError('INVALID_MUTATION')
    }
    const connection = await this.connections.resolveConnection(input.connectionId)
    const table = await this.gateways[connection.engine].describeTable(
      connection,
      input.schema,
      input.table,
    )
    const policy = buildRowWritePolicy(table)
    return {
      table,
      policy: {
        identity: policy.identity,
        writableColumns: policy.writableColumns,
        readOnlyColumns: policy.readOnlyColumns,
        canUpdate: policy.canUpdate,
        canDelete: policy.canDelete,
      },
    }
  }

  async mutate(
    actor: { id: string; role: 'admin' | 'user' },
    input: DataMutationRequest & { connectionId: string },
  ): Promise<DataMutationResult> {
    if (actor.role !== 'admin') throw new DataMutationError('FORBIDDEN')
    if (!input.connectionId.trim() || !input.schema.trim() || !input.table.trim()) {
      throw new DataMutationError('INVALID_MUTATION')
    }
    const operationCount = countRows(input.operations)
    if (operationCount < 1 || operationCount > 100) {
      throw new DataMutationError('INVALID_MUTATION')
    }

    const connection = await this.connections.resolveConnection(input.connectionId)
    const gateway = this.gateways[connection.engine]
    const table = await gateway.describeTable(connection, input.schema, input.table)
    this.validateOperations(table, input.operations)
    const request = {
      schema: input.schema,
      table: input.table,
      operations: input.operations,
      metadata: table,
    }
    const sqlTemplates = buildMutationSqlTemplates(connection.engine, request)

    try {
      const result = await gateway.executeTransaction(connection, request)
      await this.recordAudit(actor.id, input, operationCount, result.affectedRows, 'success', sqlTemplates)
      return result
    } catch (error) {
      const mutationError =
        error instanceof DataMutationError ? error : new DataMutationError('MUTATION_FAILED')
      await this.recordAudit(actor.id, input, operationCount, 0, 'failed', sqlTemplates, mutationError.code)
      throw mutationError
    }
  }

  private validateOperations(table: MutationTable, operations: DataMutationOperation[]): void {
    const policy = buildRowWritePolicy(table)
    const columns = new Map(table.columns.map((column) => [column.name, column]))

    for (const operation of operations) {
      if (operation.kind === 'insert') {
        validateWritableValues(operation.values, columns)
        continue
      }

      try {
        policy.assertMutableRow()
      } catch (error) {
        if (error instanceof RowWritePolicyError) {
          throw new DataMutationError('TABLE_WITHOUT_STABLE_KEY')
        }
        throw error
      }

      if (operation.kind === 'batch-update') {
        if (operation.rows.length === 0) throw new DataMutationError('INVALID_MUTATION')
        validateWritableValues(operation.patch, columns, true)
        for (const row of operation.rows) validateRowReference(row, table, policy.identity)
      } else {
        validateRowReference(operation, table, policy.identity)
        if (operation.kind === 'update') {
          validateWritableValues(operation.patch, columns, true)
        } else if (operation.confirmed !== true) {
          throw new DataMutationError('CONFIRMATION_REQUIRED')
        }
      }
    }
  }

  private async recordAudit(
    actorId: string,
    input: DataMutationRequest & { connectionId: string },
    operationCount: number,
    affectedRows: number,
    status: 'success' | 'failed',
    sqlTemplates: string[],
    errorCode?: string,
  ): Promise<void> {
    await this.audit.record({
      actorId,
      connectionId: input.connectionId,
      schema: input.schema,
      table: input.table,
      action: 'mutate-rows',
      operationCount,
      affectedRows,
      status,
      sqlTemplates,
      ...(errorCode ? { errorCode } : {}),
      createdAt: this.now().toISOString(),
    })
  }
}

function buildMutationSqlTemplates(
  engine: DatabaseEngine,
  request: DataMutationRequest & { metadata: MutationTable },
): string[] {
  const operations = expandMutationOperations(request.operations)
  if (engine === 'mysql') {
    return operations.map((operation) =>
      buildMysqlMutation(request.schema, request.table, operation).sql)
  }
  const returningColumn = request.metadata.uniqueKeys
    .find((key) => key.kind === 'primary')?.columns[0]
  return operations.map((operation) => buildPostgresMutation(
    request.schema,
    request.table,
    operation,
    operation.kind === 'insert' ? returningColumn : undefined,
  ).sql)
}

function countRows(operations: DataMutationOperation[]): number {
  return operations.reduce(
    (count, operation) => count + (operation.kind === 'batch-update' ? operation.rows.length : 1),
    0,
  )
}

function validateWritableValues(
  values: MutationValues,
  columns: ReadonlyMap<string, MutationTable['columns'][number]>,
  requireValue = false,
): void {
  if (requireValue && Object.keys(values).length === 0) {
    throw new DataMutationError('INVALID_MUTATION')
  }
  for (const [name, value] of Object.entries(values)) {
    const column = columns.get(name)
    if (!column || column.generated || column.valueType === 'unsupported') {
      throw new DataMutationError('UNSUPPORTED_COLUMN')
    }
    validateValueType(value, column.valueType)
  }
}

function validateRowReference(
  row: MutationRowReference,
  table: MutationTable,
  identity: ReturnType<typeof buildRowWritePolicy>['identity'],
): void {
  if (!identity) throw new DataMutationError('TABLE_WITHOUT_STABLE_KEY')
  if (!sameKeys(Object.keys(row.identity), identity.columns)) {
    throw new DataMutationError('INVALID_MUTATION')
  }
  const comparableColumns = table.columns
    .filter((column) => column.valueType !== 'unsupported')
    .map((column) => column.name)
  if (!sameKeys(Object.keys(row.original), comparableColumns)) {
    throw new DataMutationError('INVALID_MUTATION')
  }
  const columns = new Map(table.columns.map((column) => [column.name, column]))
  for (const [name, value] of Object.entries(row.identity)) {
    const column = columns.get(name)
    if (!column || value.kind === 'null' || value.kind === 'default') {
      throw new DataMutationError('INVALID_MUTATION')
    }
    validateValueType(value, column.valueType)
  }
  for (const [name, value] of Object.entries(row.original)) {
    const column = columns.get(name)
    if (!column || value.kind === 'default' || column.valueType === 'unsupported') {
      throw new DataMutationError('INVALID_MUTATION')
    }
    validateValueType(value, column.valueType)
  }
}

function validateValueType(
  value: TaggedDatabaseValue,
  expected: MutationTable['columns'][number]['valueType'],
): void {
  if (value.kind === 'value' && value.type !== expected) {
    throw new DataMutationError('INVALID_MUTATION')
  }
  try {
    decodeMutationValue(value)
  } catch {
    throw new DataMutationError('INVALID_MUTATION')
  }
}

function sameKeys(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}
