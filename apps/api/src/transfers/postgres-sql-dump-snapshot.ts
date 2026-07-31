import type { Duplex } from 'node:stream'

import { Client, type ClientConfig } from 'pg'
import Cursor from 'pg-cursor'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { postgresClientConfig } from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DdlColumnDefinition, DdlColumnType, DdlConstraint, DdlDefault, DdlRoutineArgument } from '../ddl/ddl-command.js'
import { quotePostgresIdentifier } from '../data/mutation-sql.js'
import { encodeDatabaseValue, type DatabaseValueType } from '../data/tagged-value.js'
import { encodeExactJson, type ExactJsonManifest, type ExactJsonRecord } from './exact-json-format.js'
import type { SqlDumpExportCatalogResult, SqlDumpExportPlan } from './sql-dump-export-service.js'
import type { SqlDumpObject, SqlDumpScope } from './sql-dump-manifest.js'
import {
  SqlDumpSnapshotCatalogError,
  type SqlDumpSnapshotSession,
  type SqlDumpSnapshotSessionFactory,
} from './sql-dump-snapshot-catalog.js'
import {
  buildSqlDumpTableObjects,
  tableObjectId,
  type SqlDumpTableConstraint,
  type SqlDumpTableDefinition,
  type SqlDumpTableIndex,
} from './sql-dump-table-objects.js'

const CURSOR_BATCH_SIZE = 1_000

export interface PostgresSqlDumpCursor {
  read(maxRows: number): Promise<Array<Record<string, unknown>>>
  close(): Promise<void>
}

export interface PostgresSqlDumpClient {
  connect(): Promise<unknown>
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  query(cursor: PostgresSqlDumpCursor): PostgresSqlDumpCursor
  end(): Promise<void>
}

export type PostgresSqlDumpClientFactory = (config: ClientConfig) => PostgresSqlDumpClient
export type PostgresSqlDumpCursorFactory = (sql: string, values: unknown[]) => PostgresSqlDumpCursor

export class PostgresSqlDumpSnapshotSessionFactory implements SqlDumpSnapshotSessionFactory {
  constructor(
    private readonly createClient: PostgresSqlDumpClientFactory = (config) =>
      new Client(config) as unknown as PostgresSqlDumpClient,
    private readonly createCursor: PostgresSqlDumpCursorFactory = (sql, values) =>
      new Cursor<Record<string, unknown>>(sql, values),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async open(connection: ResolvedConnection): Promise<SqlDumpSnapshotSession> {
    let client: PostgresSqlDumpClient | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      return new PostgresSqlDumpSnapshotSession(client, connection, this.createCursor, socket)
    } catch {
      try { await client?.end() } catch { /* Cleanup cannot expose driver details. */ }
      socket?.destroy()
      throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
    }
  }
}

class PostgresSqlDumpSnapshotSession implements SqlDumpSnapshotSession {
  private closed = false

  constructor(
    private readonly client: PostgresSqlDumpClient,
    private readonly connection: ResolvedConnection,
    private readonly createCursor: PostgresSqlDumpCursorFactory,
    private readonly socket?: Duplex,
  ) {}

  async begin(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await this.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  }

  async inspect(plan: SqlDumpExportPlan, signal: AbortSignal): Promise<SqlDumpExportCatalogResult> {
    throwIfAborted(signal)
    const versionResult = await this.client.query('SHOW server_version')
    const serverVersion = versionResult.rows[0]?.server_version
    if (typeof serverVersion !== 'string' || !serverVersion) failed()
    const serverMajor = parseServerMajor(serverVersion)

    const tables = await this.listTables(plan.scope, serverMajor)
    if (tables.length === 0) failed()
    const definitions = []
    for (const table of tables) {
      throwIfAborted(signal)
      definitions.push(await this.describeTable(table, serverMajor))
    }

    const schemaObjects = await this.describeSchemas(plan.scope)
    const sequenceObjects = await this.describeSequences(plan.scope, serverMajor)
    const typeObjects = await this.describeTypes(plan.scope)
    const tableObjects = definitions.flatMap((table) => buildSqlDumpTableObjects(table, plan.includeData))
    const sequenceIds = new Set(sequenceObjects.map((object) => object.id))
    for (const object of tableObjects) {
      if (object.kind !== 'table') continue
      const definition = object.createCommands.find((command) => command.kind === 'create-table')
      if (definition?.kind !== 'create-table') continue
      object.dependencies.push(...definition.columns.flatMap((column) => {
        if (column.default?.kind !== 'sequence') return []
        const id = `sequence:${column.default.schema}.${column.default.name}`
        return sequenceIds.has(id) ? [id] : []
      }))
    }
    const viewObjects = await this.describeViews(plan.scope)
    const extensionObjects = await this.describeExtensions(plan.scope)
    const routineObjects = await this.describeRoutines(plan.scope, serverMajor)
    const triggerObjects = await this.describeTriggers(plan.scope)
    const partitionObjects = await this.describePartitions(plan.scope, serverMajor)
    const schemaIds = new Set(schemaObjects.map((object) => object.id))
    for (const object of [...sequenceObjects, ...typeObjects, ...tableObjects, ...viewObjects]) {
      if (!object.schema) continue
      const schemaId = `schema:${object.schema}`
      if (schemaIds.has(schemaId) && !object.dependencies.includes(schemaId)) object.dependencies.unshift(schemaId)
    }
    for (const object of extensionObjects) {
      const command = object.createCommands[0]
      if (command?.kind !== 'create-extension' || !command.schema) continue
      const schemaId = `schema:${command.schema}`
      if (schemaIds.has(schemaId)) object.dependencies.push(schemaId)
    }
    for (const object of [...routineObjects, ...triggerObjects, ...partitionObjects]) {
      if (!object.schema) continue
      const schemaId = `schema:${object.schema}`
      if (schemaIds.has(schemaId) && !object.dependencies.includes(schemaId)) object.dependencies.unshift(schemaId)
    }
    const objects = [
      ...schemaObjects, ...sequenceObjects, ...typeObjects, ...tableObjects, ...viewObjects, ...extensionObjects,
      ...routineObjects, ...triggerObjects, ...partitionObjects,
    ]
    const objectIds = new Set(objects.map((object) => object.id))
    if (objects.some((object) => object.dependencies.some((dependency) => !objectIds.has(dependency)))) failed()
    const result: SqlDumpExportCatalogResult = {
      manifest: {
        format: 'dbweb-sql-dump',
        version: 1,
        engine: 'postgres',
        serverVersion,
        database: this.connection.database,
        scope: structuredClone(plan.scope),
        objects,
      },
      entries: [],
      rows: 0,
      tables: definitions.length,
    }

    if (plan.includeData) {
      result.entries = definitions.map((table) => ({
        path: buildSqlDumpTableObjects(table, true)[0]!.dataEntry!,
        objectId: tableObjectId(table.schema, table.name),
        kind: 'data' as const,
        content: this.streamTable(table, signal, () => { result.rows += 1 }),
      }))
    }
    return result
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT')
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await this.client.end() } finally { this.socket?.destroy() }
  }

  private async listTables(scope: SqlDumpScope, serverMajor: number): Promise<Array<{ schema: string; name: string }>> {
    const clauses = ["c.relkind IN ('r', 'p')", 'n.nspname NOT LIKE \'pg\\_%\' ESCAPE \'\\\'', "n.nspname <> 'information_schema'"]
    if (serverMajor >= 10) clauses.push('NOT c.relispartition')
    const values: unknown[] = []
    if (scope.kind === 'schema' || scope.kind === 'table') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push(`c.relname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_table_schema, c.relname AS dbweb_table_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE ${clauses.join(' AND ')}
       ORDER BY n.nspname, c.relname`,
      values,
    )
    return result.rows.map((row) => ({ schema: requiredString(row.dbweb_table_schema), name: requiredString(row.dbweb_table_name) }))
  }

  private async describeTable(
    table: { schema: string; name: string },
    serverMajor: number,
  ): Promise<SqlDumpTableDefinition> {
    const values = [table.schema, table.name]
    const columnsResult = await this.client.query(columnQuery(serverMajor), values)
    const constraintsResult = await this.client.query(CONSTRAINT_QUERY, values)
    const indexesResult = await this.client.query(INDEX_QUERY, values)
    const columns = columnsResult.rows.map(mapColumn)
    const constraints = constraintsResult.rows.map(mapConstraint)
    const primary = constraints.find((item) => item.constraint.kind === 'primary-key')
    const remaining = constraints.filter((item) => item.constraint.kind !== 'primary-key')
    return {
      schema: table.schema,
      name: table.name,
      columns,
      ...(primary?.constraint.kind === 'primary-key' ? { primaryKey: [...primary.constraint.columns] } : {}),
      constraints: remaining,
      indexes: indexesResult.rows.map(mapIndex),
    }
  }

  private async describeViews(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const values: unknown[] = []
    const clauses = ["c.relkind IN ('v', 'm')", "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'"]
    if (scope.kind === 'schema') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_view_schema, c.relname AS dbweb_view_name, c.relkind AS dbweb_view_kind,
              pg_get_viewdef(c.oid, true) AS dbweb_view_definition,
              array_remove(array_agg(DISTINCT 'table:' || dn.nspname || '.' || dc.relname), NULL) AS dbweb_dependencies,
              c.relispopulated AS dbweb_populated
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_rewrite rw ON rw.ev_class = c.oid
       LEFT JOIN pg_catalog.pg_depend dep ON dep.objid = rw.oid AND dep.classid = 'pg_rewrite'::regclass
       LEFT JOIN pg_catalog.pg_class dc ON dc.oid = dep.refobjid AND dc.relkind IN ('r', 'p')
       LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = dc.relnamespace
       WHERE ${clauses.join(' AND ')}
       GROUP BY c.oid, n.nspname, c.relname, c.relkind, c.relispopulated
       ORDER BY n.nspname, c.relname`,
      values,
    )
    return result.rows.map(mapViewObject)
  }

  private async describeSchemas(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const values: unknown[] = []
    const clauses = ["n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'"]
    if (scope.kind === 'schema') {
      values.push(scope.schema)
      clauses.push('n.nspname = $1')
    }
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_schema_name
       FROM pg_catalog.pg_namespace n
       WHERE ${clauses.join(' AND ')}
       ORDER BY n.nspname`,
      values,
    )
    return result.rows.map((row) => {
      const name = requiredString(row.dbweb_schema_name)
      return {
        id: `schema:${name}`, kind: 'schema' as const, name, dependencies: [],
        createCommands: [{ kind: 'create-schema' as const, name }],
        dropCommand: { kind: 'drop-schema' as const, name, confirmed: true },
      }
    })
  }

  private async describeSequences(scope: SqlDumpScope, serverMajor: number): Promise<SqlDumpObject[]> {
    const values: unknown[] = []
    const clauses = ["sequence_schema NOT LIKE 'pg\\_%' ESCAPE '\\'", "sequence_schema <> 'information_schema'"]
    if (scope.kind === 'schema' || scope.kind === 'table') {
      values.push(scope.schema)
      clauses.push(`sequence_schema = $${values.length}`)
    }
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push(`sequence_name IN (
        SELECT seq.relname FROM pg_catalog.pg_class seq
        JOIN pg_catalog.pg_depend dep ON dep.objid = seq.oid AND dep.deptype IN ('a', 'i')
        JOIN pg_catalog.pg_class owner ON owner.oid = dep.refobjid
        JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
        WHERE owner_ns.nspname = $1 AND owner.relname = $${values.length} AND seq.relkind = 'S'
      )`)
    }
    if (serverMajor >= 10) {
      const result = await this.client.query(
        `SELECT n.nspname AS dbweb_sequence_schema, c.relname AS dbweb_sequence_name,
                s.seqstart::text AS dbweb_sequence_start, s.seqincrement::text AS dbweb_sequence_increment,
                s.seqmin::text AS dbweb_sequence_min, s.seqmax::text AS dbweb_sequence_max,
                s.seqcache::text AS dbweb_sequence_cache, s.seqcycle AS dbweb_sequence_cycle
         FROM pg_catalog.pg_sequence s
         JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE ${sequenceCatalogClauses(scope, values)}
         ORDER BY n.nspname, c.relname`,
        values,
      )
      return result.rows.map(mapSequenceObject)
    }

    const names = await this.client.query(
      `SELECT sequence_schema AS dbweb_sequence_schema, sequence_name AS dbweb_sequence_name
       FROM information_schema.sequences
       WHERE ${clauses.join(' AND ')}
       ORDER BY sequence_schema, sequence_name`,
      values,
    )
    const objects: SqlDumpObject[] = []
    for (const row of names.rows) {
      const schema = requiredString(row.dbweb_sequence_schema)
      const name = requiredString(row.dbweb_sequence_name)
      const details = await this.client.query(
        `SELECT $1::text AS dbweb_sequence_schema, $2::text AS dbweb_sequence_name,
                start_value::text AS dbweb_sequence_start, increment_by::text AS dbweb_sequence_increment,
                min_value::text AS dbweb_sequence_min, max_value::text AS dbweb_sequence_max,
                cache_value::text AS dbweb_sequence_cache, is_cycled AS dbweb_sequence_cycle
         FROM ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`,
        [schema, name],
      )
      if (details.rows.length !== 1) failed()
      objects.push(mapSequenceObject(details.rows[0]!))
    }
    return objects
  }

  private async describeTypes(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const values: unknown[] = []
    const clauses = ["n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'", "t.typtype IN ('e', 'd')"]
    if (scope.kind === 'schema') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_type_schema, t.typname AS dbweb_type_name, t.typtype AS dbweb_type_kind,
              array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL) AS dbweb_enum_values,
              CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS dbweb_base_type,
              NOT t.typnotnull AS dbweb_nullable,
              pg_get_expr(t.typdefaultbin, 0) AS dbweb_default_expression,
              CASE WHEN t.typtype = 'd' THEN pg_get_expr(con.conbin, 0) END AS dbweb_check_expression
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
       LEFT JOIN pg_catalog.pg_constraint con ON con.contypid = t.oid AND con.contype = 'c'
       WHERE ${clauses.join(' AND ')}
       GROUP BY t.oid, n.nspname, t.typname, t.typtype, con.oid
       ORDER BY n.nspname, t.typname`,
      values,
    )
    return result.rows.map(mapTypeObject)
  }

  private async describeExtensions(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const values: unknown[] = []
    const clauses: string[] = []
    if (scope.kind === 'schema') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT e.extname AS dbweb_extension_name, n.nspname AS dbweb_extension_schema,
              e.extversion AS dbweb_extension_version
       FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
       ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY e.extname`,
      values,
    )
    return result.rows.map(mapExtensionObject)
  }

  private async describeRoutines(scope: SqlDumpScope, serverMajor: number): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const values: unknown[] = []
    const clauses = ["n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'", "l.lanname IN ('sql', 'plpgsql')"]
    if (scope.kind === 'schema') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    if (serverMajor < 11) clauses.push('NOT p.proisagg AND NOT p.proiswindow')
    const kind = serverMajor >= 11 ? 'p.prokind' : "'f'::text"
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_routine_schema, p.proname AS dbweb_routine_name,
              ${kind} AS dbweb_routine_kind,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'name', p.proargnames[s.i],
                  'mode', p.proargmodes[s.i],
                  'type', pg_catalog.format_type(COALESCE(p.proallargtypes, p.proargtypes::oid[])[s.i], NULL)
                ) ORDER BY s.i)
                FROM generate_subscripts(COALESCE(p.proallargtypes, p.proargtypes::oid[]), 1) s(i)
              ), '[]'::json) AS dbweb_arguments,
              pg_catalog.format_type(p.prorettype, NULL) AS dbweb_return_type,
              p.proretset AS dbweb_returns_set, l.lanname AS dbweb_language,
              p.prosrc AS dbweb_body, p.provolatile AS dbweb_volatility,
              p.prosecdef AS dbweb_security_definer, p.proisstrict AS dbweb_strict
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE ${clauses.join(' AND ')}
       ORDER BY n.nspname, p.proname, p.oid`,
      values,
    )
    return result.rows.map(mapRoutineObject)
  }

  private async describeTriggers(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    const values: unknown[] = []
    const clauses = ['NOT t.tgisinternal', "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'"]
    if (scope.kind === 'schema' || scope.kind === 'table') {
      values.push(scope.schema)
      clauses.push(`n.nspname = $${values.length}`)
    }
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push(`c.relname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT n.nspname AS dbweb_trigger_schema, c.relname AS dbweb_trigger_table,
              t.tgname AS dbweb_trigger_name,
              CASE WHEN (t.tgtype & 64) <> 0 THEN 'instead-of' WHEN (t.tgtype & 2) <> 0 THEN 'before' ELSE 'after' END AS dbweb_trigger_timing,
              array_remove(ARRAY[
                CASE WHEN (t.tgtype & 4) <> 0 THEN 'insert' END,
                CASE WHEN (t.tgtype & 16) <> 0 THEN 'update' END,
                CASE WHEN (t.tgtype & 8) <> 0 THEN 'delete' END,
                CASE WHEN (t.tgtype & 32) <> 0 THEN 'truncate' END
              ], NULL) AS dbweb_trigger_events,
              CASE WHEN (t.tgtype & 1) <> 0 THEN 'row' ELSE 'statement' END AS dbweb_for_each,
              pg_get_expr(t.tgqual, t.tgrelid) AS dbweb_when,
              fn.nspname AS dbweb_function_schema, p.proname AS dbweb_function_name,
              encode(t.tgargs, 'escape') AS dbweb_function_arguments
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
       WHERE ${clauses.join(' AND ')}
       ORDER BY n.nspname, c.relname, t.tgname`,
      values,
    )
    return result.rows.map(mapTriggerObject)
  }

  private async describePartitions(scope: SqlDumpScope, serverMajor: number): Promise<SqlDumpObject[]> {
    if (serverMajor < 10) return []
    const values: unknown[] = []
    const clauses = ['child.relispartition']
    if (scope.kind === 'schema' || scope.kind === 'table') {
      values.push(scope.schema)
      clauses.push(`parent_ns.nspname = $${values.length}`)
    }
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push(`parent.relname = $${values.length}`)
    }
    const result = await this.client.query(
      `SELECT child_ns.nspname AS dbweb_partition_schema, parent_ns.nspname AS dbweb_parent_schema,
              parent.relname AS dbweb_parent_table,
              child.relname AS dbweb_partition_name,
              pg_get_expr(child.relpartbound, child.oid, true) AS dbweb_partition_definition
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
       JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
       JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
       JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
       WHERE ${clauses.join(' AND ')}
       ORDER BY child_ns.nspname, child.relname`,
      values,
    )
    return result.rows.map(mapPartitionObject)
  }

  private async *streamTable(
    table: SqlDumpTableDefinition,
    signal: AbortSignal,
    countRow: () => void,
  ): AsyncIterable<Buffer> {
    const columns = table.columns.map((column) => ({ name: column.name, type: valueTypeForColumn(column) }))
    const manifest: ExactJsonManifest = {
      kind: 'manifest', format: 'dbweb-exact-json', version: 1,
      tables: [{ id: tableObjectId(table.schema, table.name), schema: table.schema, table: table.name, columns }],
    }
    const sql = `SELECT ${columns.map((column) => quotePostgresIdentifier(column.name)).join(', ')} FROM ${quotePostgresIdentifier(table.schema)}.${quotePostgresIdentifier(table.name)}`
    const cursor = this.client.query(this.createCursor(sql, []))
    let exhausted = false
    const closeOnAbort = () => { void cursor.close().catch(() => undefined) }
    signal.addEventListener('abort', closeOnAbort, { once: true })
    const records = async function* (): AsyncIterable<ExactJsonRecord> {
      try {
        for (;;) {
          throwIfAborted(signal)
          const rows = await cursor.read(CURSOR_BATCH_SIZE)
          throwIfAborted(signal)
          if (rows.length === 0) {
            exhausted = true
            return
          }
          for (const row of rows) {
            const values: ExactJsonRecord['values'] = {}
            for (const column of columns) {
              if (!(column.name in row)) failed()
              values[column.name] = encodeDatabaseValue(normalizeDate(row[column.name], column.type), column.type)
            }
            countRow()
            yield { kind: 'row', table: tableObjectId(table.schema, table.name), values }
          }
        }
      } finally {
        signal.removeEventListener('abort', closeOnAbort)
        if (!exhausted) {
          try { await cursor.close() } catch { /* The snapshot owner handles rollback. */ }
        }
      }
    }
    yield* encodeExactJson(manifest, records())
  }
}

const COLUMN_QUERY = `SELECT a.attname AS dbweb_column_name, t.typname AS dbweb_type_name,
       t.typcategory AS dbweb_type_category, pg_catalog.format_type(a.atttypid, a.atttypmod) AS dbweb_formatted_type,
       NOT a.attnotnull AS dbweb_nullable, pg_get_expr(d.adbin, d.adrelid) AS dbweb_default_expression,
       ''::text AS dbweb_identity
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`

function columnQuery(serverMajor: number): string {
  return serverMajor >= 10
    ? COLUMN_QUERY.replace("''::text AS dbweb_identity", 'a.attidentity::text AS dbweb_identity')
    : COLUMN_QUERY
}

function parseServerMajor(version: string): number {
  const value = /^(\d+)/.exec(version)?.[1]
  if (!value) failed()
  return Number(value)
}

const CONSTRAINT_QUERY = `SELECT con.conname AS dbweb_constraint_name, con.contype AS dbweb_constraint_type,
       array_agg(att.attname::text ORDER BY key.position) FILTER (WHERE att.attname IS NOT NULL) AS dbweb_columns,
       rn.nspname AS dbweb_reference_schema, rc.relname AS dbweb_reference_table,
       array_agg(ratt.attname::text ORDER BY key.position) FILTER (WHERE ratt.attname IS NOT NULL) AS dbweb_reference_columns,
       pg_get_constraintdef(con.oid, true) AS dbweb_constraint_definition,
       CASE WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid) END AS dbweb_check_expression
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, position) ON true
LEFT JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attnum = key.attnum
LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
LEFT JOIN pg_catalog.pg_attribute ratt ON ratt.attrelid = rc.oid AND ratt.attnum = con.confkey[key.position]
WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p', 'u', 'f', 'c')
GROUP BY con.oid, con.conname, con.contype, rn.nspname, rc.relname
ORDER BY CASE con.contype WHEN 'p' THEN 0 ELSE 1 END, con.conname`

const INDEX_QUERY = `SELECT idx.relname AS dbweb_index_name, am.amname AS dbweb_index_method,
       ind.indisunique AS dbweb_unique,
       array_agg(COALESCE(att.attname, pg_get_indexdef(ind.indexrelid, key.position, true))::text ORDER BY key.position) AS dbweb_targets,
       array_agg(CASE WHEN (ind.indoption[key.position - 1] & 1) = 1 THEN 'desc' ELSE 'asc' END ORDER BY key.position) AS dbweb_orders,
       pg_get_expr(ind.indpred, ind.indrelid) AS dbweb_predicate
FROM pg_catalog.pg_index ind
JOIN pg_catalog.pg_class c ON c.oid = ind.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_class idx ON idx.oid = ind.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = idx.relam
JOIN LATERAL generate_subscripts(ind.indkey, 1) AS key(position) ON true
LEFT JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attnum = ind.indkey[key.position]
LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = ind.indexrelid
WHERE n.nspname = $1 AND c.relname = $2 AND con.oid IS NULL
GROUP BY idx.relname, am.amname, ind.indisunique, ind.indexrelid, ind.indpred, ind.indrelid
ORDER BY idx.relname`

function mapColumn(row: Record<string, unknown>): DdlColumnDefinition {
  const typeName = requiredString(row.dbweb_type_name)
  const category = requiredString(row.dbweb_type_category)
  const formatted = requiredString(row.dbweb_formatted_type)
  const defaultExpression = nullableString(row.dbweb_default_expression)
  return {
    name: requiredString(row.dbweb_column_name),
    type: mapColumnType(typeName, category, formatted),
    nullable: row.dbweb_nullable === true,
    ...(row.dbweb_identity === 'a' || row.dbweb_identity === 'd' ? { identity: true } : {}),
    ...(defaultExpression ? { default: mapDefault(defaultExpression) } : {}),
  }
}

function mapColumnType(typeName: string, category: string, formatted: string): DdlColumnType {
  const length = /^(?:character varying|character)\((\d+)\)$/.exec(formatted)?.[1]
  const numeric = /^(?:numeric|decimal)\((\d+)(?:,(\d+))?\)$/.exec(formatted)
  if (typeName === 'int8') return { name: 'bigint' }
  if (typeName === 'int4') return { name: 'integer' }
  if (typeName === 'int2') return { name: 'smallint' }
  if (typeName === 'varchar') return { name: 'varchar', ...(length ? { length: Number(length) } : {}) }
  if (typeName === 'bpchar') return { name: 'char', ...(length ? { length: Number(length) } : {}) }
  if (typeName === 'numeric' || typeName === 'decimal') {
    return { name: 'numeric', ...(numeric ? { precision: Number(numeric[1]), ...(numeric[2] ? { scale: Number(numeric[2]) } : {}) } : {}) }
  }
  if (category === 'A') return { name: formatted }
  const aliases: Record<string, string> = {
    bool: 'boolean', float4: 'real', float8: 'double precision', text: 'text', date: 'date', time: 'time',
    timetz: 'time with time zone', timestamp: 'timestamp', timestamptz: 'timestamp with time zone', bytea: 'bytea',
    json: 'json', jsonb: 'jsonb', uuid: 'uuid',
  }
  const name = aliases[typeName]
  if (!name) failed()
  return { name }
}

function mapDefault(expression: string): DdlDefault {
  const sequence = /^nextval\('(?:"?([^".']+)"?)\.(?:"?([^"']+)"?)'::regclass\)$/i.exec(expression)
    ?? /^nextval\('"?([^"']+)"?'::regclass\)$/i.exec(expression)
  if (sequence) {
    return sequence.length > 2 && sequence[2]
      ? { kind: 'sequence', schema: sequence[1]!, name: sequence[2] }
      : { kind: 'sequence', schema: 'public', name: sequence[1]! }
  }
  if (expression === 'CURRENT_TIMESTAMP' || /^now\(\)$/i.test(expression)) return { kind: 'function', name: 'CURRENT_TIMESTAMP' }
  if (expression === 'CURRENT_DATE') return { kind: 'function', name: 'CURRENT_DATE' }
  if (expression === 'CURRENT_TIME') return { kind: 'function', name: 'CURRENT_TIME' }
  if (expression === 'NULL::text' || expression === 'NULL') return { kind: 'null' }
  const literal = /^'(.*)'(?:::[\w\s.[\]"]+)?$/s.exec(expression)
  if (literal) return { kind: 'literal', value: literal[1]!.replaceAll("''", "'") }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(expression)) return { kind: 'literal', value: Number(expression) }
  if (expression === 'true' || expression === 'false') return { kind: 'literal', value: expression === 'true' }
  failed()
}

function mapConstraint(row: Record<string, unknown>): SqlDumpTableConstraint {
  const name = requiredString(row.dbweb_constraint_name)
  const type = requiredString(row.dbweb_constraint_type)
  const columns = parsePostgresTextArray(row.dbweb_columns)
  let constraint: DdlConstraint
  if (type === 'p') constraint = { kind: 'primary-key', columns }
  else if (type === 'u') constraint = { kind: 'unique', columns }
  else if (type === 'c') constraint = { kind: 'check', expression: requiredString(row.dbweb_check_expression) }
  else if (type === 'f') {
    constraint = {
      kind: 'foreign-key', columns,
      referenceSchema: requiredString(row.dbweb_reference_schema),
      referenceTable: requiredString(row.dbweb_reference_table),
      referenceColumns: parsePostgresTextArray(row.dbweb_reference_columns),
      ...parseReferentialActions(nullableString(row.dbweb_constraint_definition)),
    }
  } else failed()
  return { name, constraint }
}

function parseReferentialActions(definition: string | undefined): { onDelete?: string; onUpdate?: string } {
  if (!definition) return {}
  const onDelete = /ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)/i.exec(definition)?.[1]?.toLowerCase()
  const onUpdate = /ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)/i.exec(definition)?.[1]?.toLowerCase()
  return { ...(onDelete ? { onDelete } : {}), ...(onUpdate ? { onUpdate } : {}) }
}

function mapIndex(row: Record<string, unknown>): SqlDumpTableIndex {
  const targets = parsePostgresTextArray(row.dbweb_targets)
  const orders = parsePostgresTextArray(row.dbweb_orders)
  if (targets.length === 0 || orders.length !== targets.length) failed()
  return {
    name: requiredString(row.dbweb_index_name),
    method: requiredString(row.dbweb_index_method),
    unique: row.dbweb_unique === true,
    parts: targets.map((target, index) => ({ column: target, order: orders[index] === 'desc' ? 'desc' : 'asc' })),
    ...(nullableString(row.dbweb_predicate) ? { predicate: nullableString(row.dbweb_predicate)! } : {}),
  }
}

function mapViewObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_view_schema)
  const name = requiredString(row.dbweb_view_name)
  const query = requiredString(row.dbweb_view_definition).trim()
  const dependencies = parsePostgresTextArray(row.dbweb_dependencies)
  if (row.dbweb_view_kind === 'v') {
    return {
      id: `view:${schema}.${name}`, kind: 'view', schema, name, dependencies,
      createCommands: [{ kind: 'create-view', schema, name, query, confirmed: true }],
      dropCommand: { kind: 'drop-view', schema, name, confirmed: true },
    }
  }
  if (row.dbweb_view_kind === 'm') {
    return {
      id: `materialized-view:${schema}.${name}`, kind: 'materialized-view', schema, name, dependencies,
      createCommands: [{
        kind: 'create-materialized-view', schema, name, query,
        withData: row.dbweb_populated === true, confirmed: true,
      }],
      dropCommand: { kind: 'drop-materialized-view', schema, name, confirmed: true },
    }
  }
  failed()
}

function mapSequenceObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_sequence_schema)
  const name = requiredString(row.dbweb_sequence_name)
  const start = safeInteger(row.dbweb_sequence_start)
  const increment = safeInteger(row.dbweb_sequence_increment)
  const minValue = safeInteger(row.dbweb_sequence_min)
  const maxValue = safeInteger(row.dbweb_sequence_max)
  const cache = safeInteger(row.dbweb_sequence_cache)
  return {
    id: `sequence:${schema}.${name}`, kind: 'sequence', schema, name, dependencies: [],
    createCommands: [{
      kind: 'create-sequence', schema, name,
      ...(start !== undefined ? { start } : {}),
      ...(increment !== undefined ? { increment } : {}),
      ...(minValue !== undefined ? { minValue } : {}),
      ...(maxValue !== undefined ? { maxValue } : {}),
      ...(cache !== undefined ? { cache } : {}),
      ...(row.dbweb_sequence_cycle === true ? { cycle: true } : {}),
    }],
    dropCommand: { kind: 'drop-sequence', schema, name, confirmed: true },
  }
}

function sequenceCatalogClauses(scope: SqlDumpScope, values: unknown[]): string {
  const clauses = ["n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'", "n.nspname <> 'information_schema'"]
  if (scope.kind === 'schema' || scope.kind === 'table') clauses.push('n.nspname = $1')
  if (scope.kind === 'table') {
    clauses.push(`c.oid IN (
      SELECT dep.objid FROM pg_catalog.pg_depend dep
      JOIN pg_catalog.pg_class owner ON owner.oid = dep.refobjid
      JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
      WHERE dep.deptype IN ('a', 'i') AND owner_ns.nspname = $1 AND owner.relname = $2
    )`)
  }
  if (values.length !== (scope.kind === 'table' ? 2 : scope.kind === 'schema' ? 1 : 0)) failed()
  return clauses.join(' AND ')
}

function mapTypeObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_type_schema)
  const name = requiredString(row.dbweb_type_name)
  if (row.dbweb_type_kind === 'e') {
    const values = parsePostgresTextArray(row.dbweb_enum_values)
    if (values.length === 0) failed()
    return {
      id: `type:${schema}.${name}`, kind: 'type', schema, name, dependencies: [],
      createCommands: [{ kind: 'create-enum', schema, name, values }],
      dropCommand: { kind: 'drop-type', schema, name, confirmed: true },
    }
  }
  if (row.dbweb_type_kind === 'd') {
    const defaultExpression = nullableString(row.dbweb_default_expression)
    const check = nullableString(row.dbweb_check_expression)
    return {
      id: `domain:${schema}.${name}`, kind: 'domain', schema, name, dependencies: [],
      createCommands: [{
        kind: 'create-domain', schema, name, baseType: mapFormattedType(requiredString(row.dbweb_base_type)),
        nullable: row.dbweb_nullable === true,
        ...(defaultExpression ? { default: mapDefault(defaultExpression) } : {}),
        ...(check ? { check } : {}),
        confirmed: true,
      }],
      dropCommand: { kind: 'drop-type', schema, name, confirmed: true },
    }
  }
  failed()
}

function mapExtensionObject(row: Record<string, unknown>): SqlDumpObject {
  const name = requiredString(row.dbweb_extension_name)
  const schema = requiredString(row.dbweb_extension_schema)
  const version = requiredString(row.dbweb_extension_version)
  return {
    id: `extension:${name}`, kind: 'extension', name, dependencies: [],
    createCommands: [{ kind: 'create-extension', name, schema, version, confirmed: true }],
    dropCommand: { kind: 'drop-extension', name, confirmed: true },
  }
}

function mapRoutineObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_routine_schema)
  const name = requiredString(row.dbweb_routine_name)
  const kind = requiredString(row.dbweb_routine_kind)
  if (kind !== 'f' && kind !== 'p') failed()
  const routineKind = kind === 'p' ? 'procedure' as const : 'function' as const
  const argumentsValue = row.dbweb_arguments
  if (!Array.isArray(argumentsValue)) failed()
  const routineArguments = argumentsValue.map(mapRoutineArgument)
  const returnType = nullableString(row.dbweb_return_type)
  const volatility = requiredString(row.dbweb_volatility)
  const volatilityMap = { v: 'volatile', s: 'stable', i: 'immutable' } as const
  if (!(volatility in volatilityMap)) failed()
  const createCommand = {
    kind: 'create-routine' as const,
    routineKind,
    schema,
    name,
    arguments: routineArguments,
    ...(routineKind === 'function' && returnType ? { returns: mapFormattedType(returnType) } : {}),
    ...(routineKind === 'function' && row.dbweb_returns_set === true ? { returnsSet: true } : {}),
    language: requiredString(row.dbweb_language),
    body: requiredString(row.dbweb_body),
    ...(routineKind === 'function' ? { volatility: volatilityMap[volatility as keyof typeof volatilityMap] } : {}),
    security: row.dbweb_security_definer === true ? 'definer' as const : 'invoker' as const,
    ...(routineKind === 'function' && row.dbweb_strict === true ? { strict: true } : {}),
    confirmed: true,
  }
  return {
    id: `${routineKind}:${schema}.${name}`,
    kind: routineKind,
    schema,
    name,
    dependencies: [],
    createCommands: [createCommand],
    dropCommand: {
      kind: 'drop-routine', routineKind, schema, name,
      argumentTypes: routineArguments.map((argument) => argument.type), confirmed: true,
    },
  }
}

function mapRoutineArgument(value: unknown): DdlRoutineArgument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failed()
  const row = value as Record<string, unknown>
  const modeValue = row.mode
  const modeMap = { i: 'in', o: 'out', b: 'inout' } as const
  if (modeValue !== null && modeValue !== undefined && (typeof modeValue !== 'string' || !(modeValue in modeMap))) failed()
  const name = nullableString(row.name)
  return {
    ...(name ? { name } : {}),
    ...(typeof modeValue === 'string' ? { mode: modeMap[modeValue as keyof typeof modeMap] } : {}),
    type: mapFormattedType(requiredString(row.type)),
  }
}

function mapTriggerObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_trigger_schema)
  const table = requiredString(row.dbweb_trigger_table)
  const name = requiredString(row.dbweb_trigger_name)
  const timing = requiredString(row.dbweb_trigger_timing)
  const forEach = requiredString(row.dbweb_for_each)
  const functionSchema = requiredString(row.dbweb_function_schema)
  const functionName = requiredString(row.dbweb_function_name)
  if (!['before', 'after', 'instead-of'].includes(timing) || !['row', 'statement'].includes(forEach)) failed()
  const events = parsePostgresTextArray(row.dbweb_trigger_events)
  if (events.some((event) => !['insert', 'update', 'delete', 'truncate'].includes(event))) failed()
  const functionArguments = parseTriggerArguments(row.dbweb_function_arguments)
  const when = nullableString(row.dbweb_when)
  return {
    id: `trigger:${schema}.${table}.${name}`,
    kind: 'trigger', schema, name,
    dependencies: [`table:${schema}.${table}`, `function:${functionSchema}.${functionName}`],
    createCommands: [{
      kind: 'create-trigger', schema, table, name,
      timing: timing as 'before' | 'after' | 'instead-of',
      events: events as Array<'insert' | 'update' | 'delete' | 'truncate'>,
      forEach: forEach as 'row' | 'statement',
      ...(when ? { when } : {}),
      functionSchema, functionName,
      ...(functionArguments.length > 0 ? { functionArguments } : {}),
      confirmed: true,
    }],
    dropCommand: { kind: 'drop-trigger', schema, table, name, confirmed: true },
  }
}

function mapPartitionObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_partition_schema)
  const parentSchema = nullableString(row.dbweb_parent_schema) ?? schema
  const table = requiredString(row.dbweb_parent_table)
  const name = requiredString(row.dbweb_partition_name)
  if (schema !== parentSchema) failed()
  return {
    id: `partition:${schema}.${table}.${name}`,
    kind: 'partition', schema, name,
    dependencies: [`table:${schema}.${table}`],
    createCommands: [{
      kind: 'create-partition', schema, table, name,
      definition: requiredString(row.dbweb_partition_definition), confirmed: true,
    }],
    dropCommand: { kind: 'drop-partition', schema, table, name, confirmed: true },
  }
}

function parseTriggerArguments(value: unknown): string[] {
  if (Array.isArray(value) || (typeof value === 'string' && value.startsWith('{'))) {
    return parsePostgresTextArray(value)
  }
  if (value === null || value === undefined || value === '') return []
  if (typeof value !== 'string') failed()
  const values: string[] = []
  let current = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      current += value[index]
      continue
    }
    const escape = value.slice(index + 1, index + 4)
    if (/^[0-7]{3}$/.test(escape)) {
      index += 3
      const code = Number.parseInt(escape, 8)
      if (code === 0) {
        values.push(current)
        current = ''
      } else current += String.fromCharCode(code)
      continue
    }
    index += 1
    if (index >= value.length) failed()
    current += value[index]
  }
  if (current) values.push(current)
  return values
}

function mapFormattedType(formatted: string): DdlColumnType {
  const normalized = formatted.toLowerCase()
  const numeric = /^(?:numeric|decimal)\((\d+)(?:,(\d+))?\)$/.exec(normalized)
  if (numeric) {
    return {
      name: 'numeric', precision: Number(numeric[1]),
      ...(numeric[2] ? { scale: Number(numeric[2]) } : {}),
    }
  }
  const length = /^(character varying|character)\((\d+)\)$/.exec(normalized)
  if (length) return { name: length[1] === 'character' ? 'char' : 'varchar', length: Number(length[2]) }
  const aliases: Record<string, string> = {
    bigint: 'bigint', integer: 'integer', smallint: 'smallint', numeric: 'numeric', decimal: 'numeric',
    boolean: 'boolean', real: 'real',
    'double precision': 'double precision', text: 'text', date: 'date', time: 'time',
    'time with time zone': 'time with time zone', timestamp: 'timestamp',
    'timestamp with time zone': 'timestamp with time zone', bytea: 'bytea', json: 'json', jsonb: 'jsonb', uuid: 'uuid',
  }
  const name = aliases[normalized]
  if (!name) failed()
  return { name }
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') failed()
  const parsed = typeof value === 'bigint' ? value : BigInt(String(value))
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(parsed)
}

function valueTypeForColumn(column: DdlColumnDefinition): DatabaseValueType {
  const name = column.type.name.toLowerCase()
  if (name === 'bigint') return 'bigint'
  if (name === 'smallint' || name === 'integer' || name === 'real' || name === 'double precision') return 'number'
  if (name === 'numeric' || name === 'decimal') return 'decimal'
  if (name === 'boolean') return 'boolean'
  if (name === 'date') return 'date'
  if (name === 'time' || name === 'time with time zone') return 'time'
  if (name === 'timestamp') return 'datetime'
  if (name === 'timestamp with time zone') return 'timestamptz'
  if (name === 'bytea') return 'binary'
  if (name === 'json' || name === 'jsonb') return 'json'
  if (name === 'uuid') return 'uuid'
  if (name.endsWith('[]')) return 'array'
  if (name === 'varchar' || name === 'char' || name === 'text') return 'string'
  failed()
}

function parsePostgresTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || !value.startsWith('{') || !value.endsWith('}')) failed()
  if (value === '{}') return []
  const result: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!
    if (escaped) { current += character; escaped = false }
    else if (character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
    else if (character === ',' && !quoted) { result.push(current); current = '' }
    else current += character
  }
  if (quoted || escaped) failed()
  result.push(current)
  return result
}

function normalizeDate(value: unknown, type: DatabaseValueType): unknown {
  if (!(value instanceof Date)) return value
  const iso = value.toISOString()
  if (type === 'date') return iso.slice(0, 10)
  if (type === 'datetime') return iso.slice(0, -1)
  if (type === 'timestamptz') return iso
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) failed()
  return value
}

function nullableString(value: unknown): string | undefined {
  if (value == null) return undefined
  return requiredString(value)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) failed()
}

function failed(): never {
  throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
}
