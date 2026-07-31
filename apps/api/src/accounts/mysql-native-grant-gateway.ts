import mysql, { type ConnectionOptions } from 'mysql2/promise'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  mysqlClientOptions,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from '../connections/mysql-connector.js'
import {
  NativeGrantGatewayError,
  type NativeGrantGateway,
} from './native-grant-gateway.js'
import type { NativeAccountIdentity } from './native-account-policy.js'
import type { NativeGrantChange, NativePrivilege } from './native-grant-plan.js'

const DATABASE_COLUMNS: Array<[string, NativePrivilege]> = [
  ['dbweb_select', 'select'], ['dbweb_insert', 'insert'], ['dbweb_update', 'update'],
  ['dbweb_delete', 'delete'], ['dbweb_create', 'create'], ['dbweb_alter', 'alter'],
  ['dbweb_drop', 'drop'], ['dbweb_index', 'index'], ['dbweb_references', 'references'],
]
const TABLE_PRIVILEGES = new Map<string, NativePrivilege>([
  ['select', 'select'], ['insert', 'insert'], ['update', 'update'], ['delete', 'delete'],
  ['create', 'create'], ['alter', 'alter'], ['drop', 'drop'], ['index', 'index'],
  ['references', 'references'],
])

export class MysqlNativeGrantGateway implements NativeGrantGateway {
  constructor(
    private readonly createConnection: MysqlConnectionFactory = async (options) =>
      mysql.createConnection(options as ConnectionOptions),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listGrants(
    connection: ResolvedConnection,
    targetDatabase: string,
    identity: NativeAccountIdentity,
  ): Promise<NativeGrantChange[]> {
    if (identity.engine !== 'mysql') throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0)
    return await this.withClient(connection, targetDatabase, async (client) => {
      const [databaseRows] = await client.query(`
        SELECT Db AS dbweb_database,
               Select_priv AS dbweb_select,
               Insert_priv AS dbweb_insert,
               Update_priv AS dbweb_update,
               Delete_priv AS dbweb_delete,
               Create_priv AS dbweb_create,
               Alter_priv AS dbweb_alter,
               Drop_priv AS dbweb_drop,
               Index_priv AS dbweb_index,
               References_priv AS dbweb_references
        FROM mysql.db
        WHERE User = ? AND Host = ?
      `, [identity.username, identity.host])
      const [tableRows] = await client.query(`
        SELECT Db AS dbweb_database,
               Table_name AS dbweb_table,
               Table_priv AS dbweb_privileges
        FROM mysql.tables_priv
        WHERE User = ? AND Host = ?
      `, [identity.username, identity.host])
      return mapMysqlGrants(databaseRows, tableRows, targetDatabase)
    })
  }

  async execute(
    connection: ResolvedConnection,
    targetDatabase: string,
    statements: string[],
  ): Promise<{ appliedCount: number }> {
    return await this.withClient(connection, targetDatabase, async (client) => {
      for (const [index, statement] of statements.entries()) {
        try {
          await client.query(statement)
        } catch {
          throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', index, index)
        }
      }
      return { appliedCount: statements.length }
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    targetDatabase: string,
    operation: (client: MysqlConnectionLike) => Promise<T>,
  ): Promise<T> {
    let socket: Awaited<ReturnType<DatabaseSocketProvider['open']>>
    let client: MysqlConnectionLike | undefined
    try {
      const targetConnection = { ...connection, database: targetDatabase }
      socket = await this.socketProvider?.open(targetConnection)
      client = await this.createConnection(mysqlClientOptions(targetConnection, socket))
      return await operation(client)
    } catch (error) {
      if (error instanceof NativeGrantGatewayError) throw error
      throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0)
    } finally {
      await client?.end().catch(() => undefined)
      socket?.destroy()
    }
  }
}

function mapMysqlGrants(
  databaseRows: Array<Record<string, unknown>>,
  tableRows: Array<Record<string, unknown>>,
  targetDatabase: string,
): NativeGrantChange[] {
  const grants: NativeGrantChange[] = []
  for (const row of databaseRows) {
    const database = decodeMysqlDatabasePattern(String(row.dbweb_database))
    if (database !== targetDatabase) continue
    const privileges = DATABASE_COLUMNS
      .filter(([column]) => row[column] === 'Y')
      .map(([, privilege]) => privilege)
    if (privileges.length > 0) grants.push({ scope: 'database', database, privileges })
  }
  for (const row of tableRows) {
    const database = String(row.dbweb_database)
    if (database !== targetDatabase || typeof row.dbweb_table !== 'string') continue
    const privileges = String(row.dbweb_privileges)
      .split(',')
      .map((value) => TABLE_PRIVILEGES.get(value.trim().toLowerCase()))
      .filter((value): value is NativePrivilege => value !== undefined)
    if (privileges.length > 0) {
      grants.push({ scope: 'table', database, table: row.dbweb_table, privileges })
    }
  }
  return grants
}

function decodeMysqlDatabasePattern(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length) index += 1
    result += value[index]
  }
  return result
}
