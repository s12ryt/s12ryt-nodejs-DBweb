import type { AuthUser } from '../auth/auth-types.js'
import type { SecurityAuditRecorder } from '../security/security-audit.js'

export type WebCapability =
  | 'structure-read'
  | 'data-read'
  | 'query-read'
  | 'data-write'
  | 'ddl-write'
  | 'account-manage'

export interface WebAccessAssignment {
  userId: string
  connectionId: string
  capabilities: WebCapability[]
}

export interface WebAccessRepository {
  find(userId: string, connectionId: string): Promise<WebAccessAssignment | undefined>
  listByUser(userId: string): Promise<WebAccessAssignment[]>
  replace(assignment: WebAccessAssignment): Promise<void>
  delete(userId: string, connectionId: string): Promise<void>
}

export class AccessControlError extends Error {
  constructor(readonly code: 'FORBIDDEN') {
    super(code)
    this.name = 'AccessControlError'
  }
}

const CAPABILITY_ORDER: WebCapability[] = [
  'structure-read',
  'data-read',
  'query-read',
  'data-write',
  'ddl-write',
  'account-manage',
]

const DEFAULT_CAPABILITIES: WebCapability[] = [
  'structure-read',
  'data-read',
  'query-read',
]

function expandCapabilities(requested: WebCapability[]): WebCapability[] {
  const capabilities = new Set(requested)
  if (capabilities.has('data-read')) capabilities.add('structure-read')
  if (capabilities.has('data-write')) {
    capabilities.add('structure-read')
    capabilities.add('data-read')
  }
  if (capabilities.has('ddl-write')) capabilities.add('structure-read')
  return CAPABILITY_ORDER.filter((capability) => capabilities.has(capability))
}

export class WebAccessService {
  constructor(
    private readonly repository: WebAccessRepository,
    private readonly audit?: SecurityAuditRecorder,
  ) {}

  async assign(
    actor: AuthUser,
    userId: string,
    connectionId: string,
    requested: WebCapability[] = DEFAULT_CAPABILITIES,
  ): Promise<WebAccessAssignment> {
    this.assertAdmin(actor)
    const assignment = {
      userId,
      connectionId,
      capabilities: expandCapabilities(requested),
    }
    await this.repository.replace(assignment)
    await this.audit?.record({
      actorId: actor.id,
      targetUserId: userId,
      connectionId,
      action: 'web-access-assign',
      status: 'success',
      details: { capabilities: assignment.capabilities },
    })
    return assignment
  }

  async revoke(actor: AuthUser, userId: string, connectionId: string): Promise<void> {
    this.assertAdmin(actor)
    await this.repository.delete(userId, connectionId)
    await this.audit?.record({
      actorId: actor.id,
      targetUserId: userId,
      connectionId,
      action: 'web-access-revoke',
      status: 'success',
    })
  }

  async listAssignments(actor: AuthUser, userId: string): Promise<WebAccessAssignment[]> {
    this.assertAdmin(actor)
    return this.repository.listByUser(userId)
  }

  async can(
    user: Pick<AuthUser, 'id' | 'role'>,
    connectionId: string,
    capability: WebCapability,
  ): Promise<boolean> {
    if (user.role === 'admin') return true
    const assignment = await this.repository.find(user.id, connectionId)
    return assignment?.capabilities.includes(capability) ?? false
  }

  async listVisibleConnectionIds(
    user: Pick<AuthUser, 'id' | 'role'>,
  ): Promise<string[] | undefined> {
    if (user.role === 'admin') return undefined
    const assignments = await this.repository.listByUser(user.id)
    return assignments
      .filter((assignment) => assignment.capabilities.length > 0)
      .map((assignment) => assignment.connectionId)
  }

  private assertAdmin(actor: AuthUser): void {
    if (actor.role !== 'admin') throw new AccessControlError('FORBIDDEN')
  }
}

export class MemoryWebAccessRepository implements WebAccessRepository {
  private readonly assignments = new Map<string, WebAccessAssignment>()

  async find(userId: string, connectionId: string): Promise<WebAccessAssignment | undefined> {
    const assignment = this.assignments.get(this.key(userId, connectionId))
    return assignment ? structuredClone(assignment) : undefined
  }

  async listByUser(userId: string): Promise<WebAccessAssignment[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.userId === userId)
      .map((assignment) => structuredClone(assignment))
  }

  async replace(assignment: WebAccessAssignment): Promise<void> {
    this.assignments.set(this.key(assignment.userId, assignment.connectionId), structuredClone(assignment))
  }

  async delete(userId: string, connectionId: string): Promise<void> {
    this.assignments.delete(this.key(userId, connectionId))
  }

  private key(userId: string, connectionId: string): string {
    return `${userId}\0${connectionId}`
  }
}
