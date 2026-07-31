import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'

export type QueryStatus = 'success' | 'failed' | 'cancelled' | 'timeout'

export interface QueryAuditEntry {
  queryId: string
  userId: string
  connectionId: string
  sql: string
  status: QueryStatus
  durationMs: number
  rowCount: number
  errorCode?: string
  createdAt: string
}

export interface QueryAuditRecorder {
  record(entry: QueryAuditEntry): Promise<void>
}

export interface SqlGatewayResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  affectedRows: number
}

export interface SqlGateway {
  execute(
    connection: ResolvedConnection,
    request: { sql: string; timeoutMs: number; maxRows: number; signal: AbortSignal },
  ): Promise<SqlGatewayResult>
}

export interface ExecuteQueryInput {
  queryId: string
  connectionId: string
  sql: string
  timeoutMs?: number
  rowLimit?: number
  confirmedHighRisk?: boolean
}

type QueryErrorCode =
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_QUERY'
  | 'QUERY_CANCELLED'
  | 'QUERY_FAILED'
  | 'QUERY_TIMEOUT'

export class QueryError extends Error {
  constructor(readonly code: QueryErrorCode) {
    super(code)
    this.name = 'QueryError'
  }
}

const HIGH_RISK_KEYWORDS = new Set([
  'ALTER',
  'CREATE',
  'DELETE',
  'DROP',
  'GRANT',
  'INSERT',
  'RENAME',
  'REVOKE',
  'TRUNCATE',
  'UPDATE',
])

export class SqlQueryService {
  private readonly active = new Map<string, { userId: string; controller: AbortController }>()

  constructor(
    private readonly connections: ConnectionService,
    private readonly gateways: Record<DatabaseEngine, SqlGateway>,
    private readonly audit: QueryAuditRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute(userId: string, input: ExecuteQueryInput) {
    const timeoutMs = input.timeoutMs ?? 30_000
    const rowLimit = input.rowLimit ?? 1000
    this.validate(input, timeoutMs, rowLimit)
    if (isHighRiskSql(input.sql) && input.confirmedHighRisk !== true) {
      throw new QueryError('CONFIRMATION_REQUIRED')
    }
    if (this.active.has(input.queryId)) throw new QueryError('INVALID_QUERY')

    const connection = await this.connections.resolveConnection(input.connectionId)
    const controller = new AbortController()
    this.active.set(input.queryId, { userId, controller })
    const startedAt = this.now()
    const timer = setTimeout(
      () => controller.abort(new QueryError('QUERY_TIMEOUT')),
      timeoutMs,
    )

    try {
      const result = await this.gateways[connection.engine].execute(connection, {
        sql: input.sql,
        timeoutMs,
        maxRows: rowLimit + 1,
        signal: controller.signal,
      })
      const truncated = result.rows.length > rowLimit
      const rows = truncated ? result.rows.slice(0, rowLimit) : result.rows
      await this.recordAudit(input, userId, startedAt, 'success', rows.length)
      return { ...result, rows, truncated, durationMs: Math.max(0, this.now() - startedAt) }
    } catch (error) {
      const queryError =
        controller.signal.reason instanceof QueryError
          ? controller.signal.reason
          : error instanceof QueryError
            ? error
            : new QueryError('QUERY_FAILED')
      const status =
        queryError.code === 'QUERY_CANCELLED'
          ? 'cancelled'
          : queryError.code === 'QUERY_TIMEOUT'
            ? 'timeout'
            : 'failed'
      await this.recordAudit(input, userId, startedAt, status, 0, queryError.code)
      throw queryError
    } finally {
      clearTimeout(timer)
      if (this.active.get(input.queryId)?.controller === controller) this.active.delete(input.queryId)
    }
  }

  async cancel(userId: string, queryId: string): Promise<boolean> {
    const active = this.active.get(queryId)
    if (!active || active.userId !== userId) return false
    active.controller.abort(new QueryError('QUERY_CANCELLED'))
    return true
  }

  private validate(input: ExecuteQueryInput, timeoutMs: number, rowLimit: number) {
    if (
      !input.queryId.trim() ||
      !input.connectionId.trim() ||
      !input.sql.trim() ||
      input.sql.length > 1_048_576 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 300_000 ||
      !Number.isInteger(rowLimit) ||
      rowLimit < 1 ||
      rowLimit > 10_000
    ) {
      throw new QueryError('INVALID_QUERY')
    }
  }

  private async recordAudit(
    input: ExecuteQueryInput,
    userId: string,
    startedAt: number,
    status: QueryStatus,
    rowCount: number,
    errorCode?: string,
  ) {
    await this.audit.record({
      queryId: input.queryId,
      userId,
      connectionId: input.connectionId,
      sql: input.sql,
      status,
      durationMs: Math.max(0, this.now() - startedAt),
      rowCount,
      ...(errorCode ? { errorCode } : {}),
      createdAt: new Date().toISOString(),
    })
  }
}

export function isHighRiskSql(sql: string): boolean {
  const withoutComments = sql
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/--[^\r\n]*/g, ' ')
  return withoutComments.split(';').some((statement) => {
    const keyword = /^\s*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase()
    return keyword ? HIGH_RISK_KEYWORDS.has(keyword) : false
  })
}
