import type {
  WebAccessAssignment,
  WebAccessRepository,
  WebCapability,
} from '../access/web-access-service.js'
import type { MetadataKysely } from './metadata-database.js'

type AssignmentRow = {
  user_id: string
  connection_id: string
  structure_read: number
  data_read: number
  query_read: number
  data_write: number
  ddl_write: number
  account_manage: number
}

export class KyselyWebAccessRepository implements WebAccessRepository {
  constructor(private readonly database: MetadataKysely) {}

  async find(userId: string, connectionId: string): Promise<WebAccessAssignment | undefined> {
    const row = await this.database
      .selectFrom('web_access_assignments')
      .selectAll()
      .where('user_id', '=', userId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst()
    return row ? this.map(row) : undefined
  }

  async listByUser(userId: string): Promise<WebAccessAssignment[]> {
    const rows = await this.database
      .selectFrom('web_access_assignments')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('connection_id')
      .execute()
    return rows.map((row) => this.map(row))
  }

  async replace(assignment: WebAccessAssignment): Promise<void> {
    const values = this.values(assignment)
    await this.database
      .insertInto('web_access_assignments')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['user_id', 'connection_id']).doUpdateSet({
          structure_read: values.structure_read,
          data_read: values.data_read,
          query_read: values.query_read,
          data_write: values.data_write,
          ddl_write: values.ddl_write,
          account_manage: values.account_manage,
        }),
      )
      .execute()
  }

  async delete(userId: string, connectionId: string): Promise<void> {
    await this.database
      .deleteFrom('web_access_assignments')
      .where('user_id', '=', userId)
      .where('connection_id', '=', connectionId)
      .execute()
  }

  private values(assignment: WebAccessAssignment): AssignmentRow {
    const capabilities = new Set(assignment.capabilities)
    return {
      user_id: assignment.userId,
      connection_id: assignment.connectionId,
      structure_read: this.flag(capabilities, 'structure-read'),
      data_read: this.flag(capabilities, 'data-read'),
      query_read: this.flag(capabilities, 'query-read'),
      data_write: this.flag(capabilities, 'data-write'),
      ddl_write: this.flag(capabilities, 'ddl-write'),
      account_manage: this.flag(capabilities, 'account-manage'),
    }
  }

  private map(row: AssignmentRow): WebAccessAssignment {
    const capabilities: WebCapability[] = []
    if (row.structure_read) capabilities.push('structure-read')
    if (row.data_read) capabilities.push('data-read')
    if (row.query_read) capabilities.push('query-read')
    if (row.data_write) capabilities.push('data-write')
    if (row.ddl_write) capabilities.push('ddl-write')
    if (row.account_manage) capabilities.push('account-manage')
    return {
      userId: row.user_id,
      connectionId: row.connection_id,
      capabilities,
    }
  }

  private flag(capabilities: ReadonlySet<WebCapability>, capability: WebCapability): number {
    return capabilities.has(capability) ? 1 : 0
  }
}
