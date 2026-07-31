import { Client } from 'pg'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  postgresClientConfig,
  type PostgresClientFactory,
  type PostgresClientLike,
} from '../connections/postgres-connector.js'
import {
  NativeGrantGatewayError,
  type NativeGrantGateway,
} from './native-grant-gateway.js'
import type { NativeAccountIdentity } from './native-account-policy.js'
import type { NativeGrantChange, NativePrivilege } from './native-grant-plan.js'

const DATABASE_PRIVILEGES = new Set<NativePrivilege>(['connect', 'create'])
const SCHEMA_PRIVILEGES = new Set<NativePrivilege>(['usage', 'create'])
const TABLE_PRIVILEGES = new Set<NativePrivilege>(['select', 'insert', 'update', 'delete', 'references'])

export class PostgresNativeGrantGateway implements NativeGrantGateway {
  constructor(
    private readonly createClient: PostgresClientFactory = (config) => new Client(config),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async listGrants(
    connection: ResolvedConnection,
    targetDatabase: string,
    identity: NativeAccountIdentity,
  ): Promise<NativeGrantChange[]> {
    if (identity.engine !== 'postgres') throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0)
    return await this.withClient(connection, targetDatabase, async (client) => {
      const database = await client.query(`
        SELECT 'database' AS dbweb_scope,
               d.datname AS dbweb_database,
               privilege.privilege_type AS dbweb_privilege
        FROM pg_catalog.pg_database AS d
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))
        ) AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE d.datname = $1 AND grantee.rolname = $2
      `, [targetDatabase, identity.username])
      const schemas = await client.query(`
        SELECT 'schema' AS dbweb_scope,
               current_database() AS dbweb_database,
               namespace.nspname AS dbweb_schema,
               privilege.privilege_type AS dbweb_privilege
        FROM pg_catalog.pg_namespace AS namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
        ) AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE grantee.rolname = $1
      `, [identity.username])
      const tables = await client.query(`
        SELECT 'table' AS dbweb_scope,
               current_database() AS dbweb_database,
               namespace.nspname AS dbweb_schema,
               relation.relname AS dbweb_table,
               privilege.privilege_type AS dbweb_privilege
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE relation.relkind IN ('r', 'v', 'm', 'f') AND grantee.rolname = $1
      `, [identity.username])
      return groupPostgresGrants([...database.rows, ...schemas.rows, ...tables.rows])
    })
  }

  async execute(
    connection: ResolvedConnection,
    targetDatabase: string,
    statements: string[],
  ): Promise<{ appliedCount: number }> {
    return await this.withClient(connection, targetDatabase, async (client) => {
      let failedIndex = 0
      try {
        await client.query('BEGIN')
        for (const [index, statement] of statements.entries()) {
          failedIndex = index
          await client.query(statement)
        }
        await client.query('COMMIT')
        return { appliedCount: statements.length }
      } catch {
        await client.query('ROLLBACK').catch(() => undefined)
        throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, failedIndex)
      }
    })
  }

  private async withClient<T>(
    connection: ResolvedConnection,
    targetDatabase: string,
    operation: (client: PostgresClientLike) => Promise<T>,
  ): Promise<T> {
    let socket: Awaited<ReturnType<DatabaseSocketProvider['open']>>
    let client: PostgresClientLike | undefined
    try {
      const targetConnection = { ...connection, database: targetDatabase }
      socket = await this.socketProvider?.open(targetConnection)
      client = this.createClient(postgresClientConfig(targetConnection, socket))
      await client.connect()
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

function groupPostgresGrants(rows: Array<Record<string, unknown>>): NativeGrantChange[] {
  const grouped = new Map<string, NativeGrantChange>()
  for (const row of rows) {
    const scope = row.dbweb_scope
    const database = row.dbweb_database
    const privilege = String(row.dbweb_privilege).toLowerCase() as NativePrivilege
    if (typeof database !== 'string') continue
    if (scope === 'database' && DATABASE_PRIVILEGES.has(privilege)) {
      addPrivilege(grouped, `database:${database}`, { scope, database, privileges: [] }, privilege)
    } else if (scope === 'schema' && typeof row.dbweb_schema === 'string' && SCHEMA_PRIVILEGES.has(privilege)) {
      addPrivilege(grouped, `schema:${database}:${row.dbweb_schema}`, {
        scope, database, schema: row.dbweb_schema, privileges: [],
      }, privilege)
    } else if (
      scope === 'table' &&
      typeof row.dbweb_schema === 'string' &&
      typeof row.dbweb_table === 'string' &&
      TABLE_PRIVILEGES.has(privilege)
    ) {
      addPrivilege(grouped, `table:${database}:${row.dbweb_schema}:${row.dbweb_table}`, {
        scope, database, schema: row.dbweb_schema, table: row.dbweb_table, privileges: [],
      }, privilege)
    }
  }
  return [...grouped.values()]
}

function addPrivilege(
  grouped: Map<string, NativeGrantChange>,
  key: string,
  initial: NativeGrantChange,
  privilege: NativePrivilege,
): void {
  const grant = grouped.get(key) ?? initial
  grant.privileges.push(privilege)
  grouped.set(key, grant)
}
