import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import { detectDdlCapabilities, type DdlCapabilities } from './ddl-capabilities.js'
import type { DdlCommand } from './ddl-command.js'
import { buildDdlStatements } from './ddl-sql-builder.js'

export interface DdlGateway {
  serverVersion(connection: ResolvedConnection): Promise<string>
  execute(
    connection: ResolvedConnection,
    statements: string[],
    options: { transactional: boolean },
  ): Promise<void>
}

export interface DdlAuditEntry {
  actorId: string
  connectionId: string
  objectType: 'database' | 'schema' | 'table' | 'column' | 'index' | 'constraint'
  objectName: string
  action: DdlCommand['kind']
  statementCount: number
  transactional: boolean
  status: 'success' | 'failed'
  sqlTemplates: string[]
  errorCode?: string
  createdAt: string
}

export interface DdlAuditRecorder {
  record(entry: DdlAuditEntry): Promise<void>
}

export type DdlServiceErrorCode = 'DDL_FAILED' | 'FORBIDDEN'

export class DdlServiceError extends Error {
  constructor(readonly code: DdlServiceErrorCode) {
    super(code)
    this.name = 'DdlServiceError'
  }
}

export class DdlService {
  constructor(
    private readonly connections: ConnectionService,
    private readonly gateways: Record<DatabaseEngine, DdlGateway>,
    private readonly audit: DdlAuditRecorder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async capabilities(
    actor: { id: string; role: 'admin' | 'user' },
    connectionId: string,
  ): Promise<DdlCapabilities> {
    this.requireAdmin(actor)
    const connection = await this.connections.resolveConnection(connectionId)
    try {
      const version = await this.gateways[connection.engine].serverVersion(connection)
      return detectDdlCapabilities(connection.engine, version)
    } catch {
      throw new DdlServiceError('DDL_FAILED')
    }
  }

  async execute(
    actor: { id: string; role: 'admin' | 'user' },
    input: { connectionId: string; command: DdlCommand },
  ): Promise<{ statementsExecuted: number; transactional: boolean }> {
    this.requireAdmin(actor)
    const connection = await this.connections.resolveConnection(input.connectionId)
    let capabilities: DdlCapabilities
    try {
      const version = await this.gateways[connection.engine].serverVersion(connection)
      capabilities = detectDdlCapabilities(connection.engine, version)
    } catch {
      throw new DdlServiceError('DDL_FAILED')
    }
    const statements = buildDdlStatements(capabilities, input.command)
    const transactional = capabilities.transactionalDdl && !isDatabaseCommand(input.command)
    const descriptor = describeObject(input.command)

    try {
      await this.gateways[connection.engine].execute(connection, statements, { transactional })
      await this.record(actor.id, input, descriptor, statements, transactional, 'success')
      return { statementsExecuted: statements.length, transactional }
    } catch {
      await this.record(actor.id, input, descriptor, statements, transactional, 'failed', 'DDL_FAILED')
      throw new DdlServiceError('DDL_FAILED')
    }
  }

  private requireAdmin(actor: { role: 'admin' | 'user' }): void {
    if (actor.role !== 'admin') throw new DdlServiceError('FORBIDDEN')
  }

  private async record(
    actorId: string,
    input: { connectionId: string; command: DdlCommand },
    descriptor: ReturnType<typeof describeObject>,
    sqlTemplates: string[],
    transactional: boolean,
    status: 'success' | 'failed',
    errorCode?: string,
  ): Promise<void> {
    await this.audit.record({
      actorId,
      connectionId: input.connectionId,
      objectType: descriptor.type,
      objectName: descriptor.name,
      action: input.command.kind,
      statementCount: sqlTemplates.length,
      transactional,
      status,
      sqlTemplates,
      ...(errorCode ? { errorCode } : {}),
      createdAt: this.now().toISOString(),
    })
  }
}

function isDatabaseCommand(command: DdlCommand): boolean {
  return command.kind.endsWith('-database')
}

function describeObject(command: DdlCommand): {
  type: DdlAuditEntry['objectType']
  name: string
} {
  switch (command.kind) {
    case 'create-database':
    case 'drop-database':
      return { type: 'database', name: command.name }
    case 'rename-database':
      return { type: 'database', name: command.from }
    case 'create-schema':
    case 'drop-schema':
      return { type: 'schema', name: command.name }
    case 'rename-schema':
      return { type: 'schema', name: command.from }
    case 'create-table':
    case 'drop-table':
      return { type: 'table', name: `${command.schema}.${command.name}` }
    case 'rename-table':
      return { type: 'table', name: `${command.schema}.${command.from}` }
    case 'add-column':
      return { type: 'column', name: `${command.schema}.${command.table}.${command.column.name}` }
    case 'rename-column':
      return { type: 'column', name: `${command.schema}.${command.table}.${command.from}` }
    case 'drop-column':
      return { type: 'column', name: `${command.schema}.${command.table}.${command.name}` }
    case 'create-index':
    case 'drop-index':
      return { type: 'index', name: `${command.schema}.${command.table}.${command.name}` }
    case 'add-constraint':
    case 'drop-constraint':
      return { type: 'constraint', name: `${command.schema}.${command.table}.${command.name}` }
  }
}
