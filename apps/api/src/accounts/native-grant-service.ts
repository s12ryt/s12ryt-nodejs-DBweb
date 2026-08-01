import type { AuthUser } from '../auth/auth-types.js'
import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import type { SecurityAuditRecorder } from '../security/security-audit.js'
import type { NativeAccountGateway } from './native-account-service.js'
import {
  identityKey,
  isProtectedNativeAccount,
  normalizeNativeAccountIdentity,
  type NativeAccountIdentity,
} from './native-account-policy.js'
import { NativeGrantGatewayError, type NativeGrantGateway } from './native-grant-gateway.js'
import {
  buildNativeGrantPlan,
  validateNativeGrantTarget,
  type NativeGrantChange,
  type NativeGrantCommand,
} from './native-grant-plan.js'

type Actor = Pick<AuthUser, 'id' | 'role'>
type NativeAccountDirectory = Pick<NativeAccountGateway, 'listAccounts'>

export type NativeGrantAuthorizer = (actor: Actor, connectionId: string) => Promise<boolean>

export class NativeGrantServiceError extends Error {
  constructor(
    readonly code: 'ACCOUNT_NOT_FOUND' | 'FORBIDDEN' | 'NATIVE_GRANT_FAILED' | 'PROTECTED_ACCOUNT',
    readonly appliedCount?: number,
    readonly failedIndex?: number,
  ) {
    super(code)
    this.name = 'NativeGrantServiceError'
  }
}

export class NativeGrantService {
  constructor(
    private readonly connections: Pick<ConnectionService, 'resolveConnection'>,
    private readonly accountDirectories: Record<DatabaseEngine, NativeAccountDirectory>,
    private readonly gateways: Record<DatabaseEngine, NativeGrantGateway>,
    private readonly authorize: NativeGrantAuthorizer = async (actor) => actor.role === 'admin',
    private readonly securityAudit?: SecurityAuditRecorder,
  ) {}

  async list(
    actor: Actor,
    connectionId: string,
    targetDatabase: string,
    identity: NativeAccountIdentity,
  ): Promise<NativeGrantChange[]> {
    await this.requireAuthorized(actor, connectionId)
    const { connection, normalizedIdentity } = await this.loadActual(
      connectionId,
      targetDatabase,
      identity,
    )
    return await this.gateways[connection.engine].listGrants(
      connection,
      targetDatabase,
      normalizedIdentity,
    )
  }

  async execute(
    actor: Actor,
    connectionId: string,
    command: NativeGrantCommand,
  ): Promise<{ appliedCount: number }> {
    await this.requireAuthorized(actor, connectionId)
    const plan = buildNativeGrantPlan(command.identity.engine, command)
    const { connection, account, normalizedIdentity } = await this.loadActual(
      connectionId,
      plan.targetDatabase,
      command.identity,
    )
    if (isProtectedNativeAccount(account, connection).protected) {
      throw new NativeGrantServiceError('PROTECTED_ACCOUNT')
    }

    const normalizedCommand = { ...command, identity: normalizedIdentity }
    const normalizedPlan = buildNativeGrantPlan(connection.engine, normalizedCommand)
    if (connection.engine === 'mysql') {
      return await this.executeMysql(
        actor,
        connectionId,
        connection,
        normalizedCommand,
        normalizedPlan.statements,
      )
    }

    try {
      const result = await this.gateways.postgres.execute(
        connection,
        normalizedPlan.targetDatabase,
        normalizedPlan.statements,
      )
      await this.audit(actor, connectionId, normalizedCommand, normalizedPlan.statements, 'success', result.appliedCount)
      return result
    } catch (error) {
      if (error instanceof DatabaseOperationGateError) throw error
      const failure = error instanceof NativeGrantGatewayError
        ? error
        : new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0)
      await this.audit(
        actor,
        connectionId,
        normalizedCommand,
        normalizedPlan.statements,
        'failed',
        failure.appliedCount,
        failure.failedIndex,
      )
      throw new NativeGrantServiceError('NATIVE_GRANT_FAILED', failure.appliedCount, failure.failedIndex)
    }
  }

  private async executeMysql(
    actor: Actor,
    connectionId: string,
    connection: ResolvedConnection,
    command: NativeGrantCommand,
    statements: string[],
  ): Promise<{ appliedCount: number }> {
    let appliedCount = 0
    for (const [index, statement] of statements.entries()) {
      try {
        await this.gateways.mysql.execute(connection, command.changes[0]!.database, [statement])
        appliedCount += 1
        await this.audit(actor, connectionId, command, [statement], 'success', appliedCount)
      } catch (error) {
        if (error instanceof DatabaseOperationGateError) throw error
        await this.audit(actor, connectionId, command, [statement], 'failed', appliedCount, index)
        throw new NativeGrantServiceError('NATIVE_GRANT_FAILED', appliedCount, index)
      }
    }
    return { appliedCount }
  }

  private async loadActual(
    connectionId: string,
    targetDatabase: string,
    identity: NativeAccountIdentity,
  ) {
    const connection = await this.connections.resolveConnection(connectionId)
    validateNativeGrantTarget(connection.engine, targetDatabase)
    const normalizedIdentity = normalizeNativeAccountIdentity(connection.engine, identity)
    const account = (await this.accountDirectories[connection.engine].listAccounts(connection))
      .find((candidate) => identityKey(candidate.identity) === identityKey(normalizedIdentity))
    if (!account) throw new NativeGrantServiceError('ACCOUNT_NOT_FOUND')
    return { connection, account, normalizedIdentity }
  }

  private async requireAuthorized(actor: Actor, connectionId: string): Promise<void> {
    if (!await this.authorize(actor, connectionId)) throw new NativeGrantServiceError('FORBIDDEN')
  }

  private async audit(
    actor: Actor,
    connectionId: string,
    command: NativeGrantCommand,
    sqlTemplates: string[],
    status: 'success' | 'failed',
    appliedCount: number,
    failedIndex?: number,
  ): Promise<void> {
    await this.securityAudit?.record({
      actorId: actor.id,
      connectionId,
      action: command.kind === 'grant' ? 'native-grant' : 'native-revoke',
      status,
      details: {
        nativeIdentity: identityKey(command.identity),
        targetDatabase: command.changes[0]!.database,
        sqlTemplates,
        appliedCount,
        ...(failedIndex === undefined ? {} : { failedIndex }),
      },
      ...(status === 'failed' ? { errorCode: 'NATIVE_GRANT_FAILED' } : {}),
    })
  }
}
