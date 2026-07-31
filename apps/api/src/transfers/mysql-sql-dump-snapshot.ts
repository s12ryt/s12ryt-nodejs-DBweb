import type { Duplex, Readable } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { DdlColumnDefinition, DdlColumnType, DdlDefault, DdlEventSchedule, DdlRoutineArgument } from '../ddl/ddl-command.js'
import { quoteMysqlIdentifier } from '../data/mutation-sql.js'
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

interface MysqlStreamingQuery {
  stream(options: { objectMode: true; highWaterMark: number }): Readable
}

export interface MysqlSqlDumpConnection {
  query(
    sql: string,
    values: unknown[] | ((error?: Error, rows?: unknown) => void),
    callback?: (error?: Error, rows?: unknown) => void,
  ): unknown
  end(callback: (error?: Error) => void): void
  destroy(): void
}

export type MysqlSqlDumpConnectionFactory = (
  options: MysqlClientOptions & { supportBigNumbers: true; bigNumberStrings: true; dateStrings: true },
) => Promise<MysqlSqlDumpConnection>

export type MysqlSqlDumpRowStreamFactory = (
  connection: MysqlSqlDumpConnection,
  sql: string,
  values: unknown[],
) => Readable

export class MysqlSqlDumpSnapshotSessionFactory implements SqlDumpSnapshotSessionFactory {
  constructor(
    private readonly createConnection: MysqlSqlDumpConnectionFactory = connectMysql,
    private readonly createRowStream: MysqlSqlDumpRowStreamFactory = (connection, sql, values) =>
      (connection.query(sql, values) as MysqlStreamingQuery).stream({ objectMode: true, highWaterMark: 1_000 }),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async open(connection: ResolvedConnection): Promise<SqlDumpSnapshotSession> {
    let client: MysqlSqlDumpConnection | undefined
    let socket: Duplex | undefined
    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection({
        ...mysqlClientOptions(connection, socket),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      })
      return new MysqlSqlDumpSnapshotSession(client, connection, this.createRowStream, socket)
    } catch {
      try { await end(client) } catch { client?.destroy() }
      socket?.destroy()
      throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
    }
  }
}

class MysqlSqlDumpSnapshotSession implements SqlDumpSnapshotSession {
  private closed = false

  constructor(
    private readonly client: MysqlSqlDumpConnection,
    private readonly connection: ResolvedConnection,
    private readonly createRowStream: MysqlSqlDumpRowStreamFactory,
    private readonly socket?: Duplex,
  ) {}

  async begin(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await query(this.client, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await query(this.client, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  }

  async inspect(plan: SqlDumpExportPlan, signal: AbortSignal): Promise<SqlDumpExportCatalogResult> {
    throwIfAborted(signal)
    const versionRows = asRows(await query(this.client, 'SELECT VERSION() AS dbweb_version'))
    const serverVersion = requiredString(versionRows[0]?.dbweb_version)
    const serverVersionTuple = parseServerVersion(serverVersion)
    const tables = await this.listTables(plan.scope)
    if (tables.length === 0) failed()
    const definitions = []
    for (const table of tables) {
      throwIfAborted(signal)
      definitions.push(await this.describeTable(table, serverVersionTuple))
    }
    const tableObjects = definitions.flatMap((table) => buildSqlDumpTableObjects(table, plan.includeData))
    const viewObjects = await this.describeViews(plan.scope)
    const routineObjects = await this.describeRoutines(plan.scope)
    const triggerObjects = await this.describeTriggers(plan.scope)
    const eventObjects = await this.describeEvents(plan.scope)
    const partitionObjects = await this.describePartitions(plan.scope)
    const objects = [...tableObjects, ...viewObjects, ...routineObjects, ...triggerObjects, ...eventObjects, ...partitionObjects]
    const objectIds = new Set(objects.map((object) => object.id))
    if (objects.some((object) => object.dependencies.some((dependency) => !objectIds.has(dependency)))) failed()
    const result: SqlDumpExportCatalogResult = {
      manifest: {
        format: 'dbweb-sql-dump', version: 1, engine: 'mysql', serverVersion,
        database: this.connection.database, scope: structuredClone(plan.scope), objects,
      },
      entries: [], rows: 0, tables: definitions.length,
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

  async commit(): Promise<void> { await query(this.client, 'COMMIT') }
  async rollback(): Promise<void> { await query(this.client, 'ROLLBACK') }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await end(this.client) } catch { this.client.destroy() } finally { this.socket?.destroy() }
  }

  private async listTables(scope: SqlDumpScope): Promise<MysqlTableRow[]> {
    const clauses = ["t.table_type = 'BASE TABLE'"]
    const values: unknown[] = []
    if (scope.kind === 'database') {
      clauses.push('t.table_schema = ?')
      values.push(this.connection.database)
    } else {
      clauses.push('t.table_schema = ?')
      values.push(scope.schema)
    }
    if (scope.kind === 'table') {
      clauses.push('t.table_name = ?')
      values.push(scope.table)
    }
    const rows = asRows(await query(this.client,
      `SELECT t.table_schema AS dbweb_table_schema, t.table_name AS dbweb_table_name,
              t.engine AS dbweb_engine, t.table_collation AS dbweb_collation,
              SUBSTRING_INDEX(t.table_collation, '_', 1) AS dbweb_charset
       FROM information_schema.tables t
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.table_schema, t.table_name`, values))
    return rows.map((row) => ({
      schema: requiredString(row.dbweb_table_schema),
      name: requiredString(row.dbweb_table_name),
      engine: requiredString(row.dbweb_engine),
      collation: requiredString(row.dbweb_collation),
      charset: requiredString(row.dbweb_charset),
    }))
  }

  private async describeTable(
    table: MysqlTableRow,
    serverVersion: readonly [number, number, number],
  ): Promise<SqlDumpTableDefinition> {
    const values = [table.schema, table.name]
    const columns = asRows(await query(this.client, COLUMN_QUERY, values)).map(mapColumn)
    const indexRows = asRows(await query(this.client, INDEX_QUERY, values))
    const grouped = groupIndexes(indexRows)
    const primary = grouped.find((index) => index.name === 'PRIMARY')
    const constraints: SqlDumpTableConstraint[] = grouped
      .filter((index) => index.name !== 'PRIMARY' && index.unique)
      .map((index) => ({ name: index.name, constraint: { kind: 'unique', columns: index.parts.map(requiredColumnPart) } }))
    constraints.push(...groupForeignKeys(asRows(await query(this.client, FOREIGN_KEY_QUERY, values))))
    if (versionAtLeast(serverVersion, [8, 0, 16])) {
      constraints.push(...asRows(await query(this.client, CHECK_QUERY, values)).map((row) => ({
        name: requiredString(row.dbweb_constraint_name),
        constraint: { kind: 'check' as const, expression: requiredString(row.dbweb_check_expression) },
      })))
    }
    const indexes: SqlDumpTableIndex[] = grouped
      .filter((index) => index.name !== 'PRIMARY' && !index.unique)
      .map(({ name, method, unique, parts }) => ({ name, method, unique, parts }))
    return {
      schema: table.schema, name: table.name, columns,
      ...(primary ? { primaryKey: primary.parts.map(requiredColumnPart) } : {}),
      constraints, indexes, engine: table.engine, charset: table.charset, collation: table.collation,
    }
  }

  private async describeViews(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const database = scope.kind === 'database' ? this.connection.database : scope.schema
    const rows = asRows(await query(this.client,
      `SELECT v.table_schema AS dbweb_view_schema, v.table_name AS dbweb_view_name,
              v.view_definition AS dbweb_view_definition,
              GROUP_CONCAT(DISTINCT CONCAT('table:', u.table_schema, '.', u.table_name)
                           ORDER BY u.table_schema, u.table_name SEPARATOR ',') AS dbweb_dependencies
       FROM information_schema.views v
       LEFT JOIN information_schema.view_table_usage u
         ON u.view_schema = v.table_schema AND u.view_name = v.table_name
       WHERE v.table_schema = ?
       GROUP BY v.table_schema, v.table_name, v.view_definition
       ORDER BY v.table_name`, [database]))
    return rows.map(mapViewObject)
  }

  private async describeRoutines(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const database = scope.kind === 'database' ? this.connection.database : scope.schema
    const rows = asRows(await query(this.client,
      `SELECT routine_schema AS dbweb_routine_schema, routine_name AS dbweb_routine_name,
              routine_type AS dbweb_routine_type, dtd_identifier AS dbweb_return_type,
              routine_definition AS dbweb_body, is_deterministic AS dbweb_deterministic,
              sql_data_access AS dbweb_data_access, security_type AS dbweb_security
       FROM information_schema.routines
       WHERE routine_schema = ?
       ORDER BY routine_name, routine_type`, [database]))
    const objects: SqlDumpObject[] = []
    for (const row of rows) {
      const schema = requiredString(row.dbweb_routine_schema)
      const name = requiredString(row.dbweb_routine_name)
      const routineType = requiredString(row.dbweb_routine_type)
      const parameters = asRows(await query(this.client,
        `SELECT parameter_name AS dbweb_parameter_name, parameter_mode AS dbweb_parameter_mode,
                dtd_identifier AS dbweb_parameter_type, ordinal_position AS dbweb_parameter_position
         FROM information_schema.parameters
         WHERE specific_schema = ? AND specific_name = ?
         ORDER BY ordinal_position`, [schema, name]))
      objects.push(mapRoutineObject(row, parameters, routineType))
    }
    return objects
  }

  private async describeTriggers(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    const database = scope.kind === 'database' ? this.connection.database : scope.schema
    const values: unknown[] = [database]
    const clauses = ['trigger_schema = ?']
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push('event_object_table = ?')
    }
    const rows = asRows(await query(this.client,
      `SELECT trigger_schema AS dbweb_trigger_schema, event_object_table AS dbweb_trigger_table,
              trigger_name AS dbweb_trigger_name, action_timing AS dbweb_trigger_timing,
              event_manipulation AS dbweb_trigger_event, action_statement AS dbweb_trigger_body
       FROM information_schema.triggers
       WHERE ${clauses.join(' AND ')}
       ORDER BY event_object_table, trigger_name`, values))
    return rows.map(mapTriggerObject)
  }

  private async describeEvents(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    if (scope.kind === 'table') return []
    const database = scope.kind === 'database' ? this.connection.database : scope.schema
    const rows = asRows(await query(this.client,
      `SELECT event_schema AS dbweb_event_schema, event_name AS dbweb_event_name,
              event_definition AS dbweb_event_body, execute_at AS dbweb_execute_at,
              interval_value AS dbweb_interval_value, interval_field AS dbweb_interval_field,
              on_completion AS dbweb_on_completion, status AS dbweb_status
       FROM information_schema.events
       WHERE event_schema = ?
       ORDER BY event_name`, [database]))
    return rows.map(mapEventObject)
  }

  private async describePartitions(scope: SqlDumpScope): Promise<SqlDumpObject[]> {
    const database = scope.kind === 'database' ? this.connection.database : scope.schema
    const values: unknown[] = [database]
    const clauses = ['table_schema = ?', 'partition_name IS NOT NULL']
    if (scope.kind === 'table') {
      values.push(scope.table)
      clauses.push('table_name = ?')
    }
    const rows = asRows(await query(this.client,
      `SELECT table_schema AS dbweb_partition_schema, table_name AS dbweb_partition_table,
              partition_name AS dbweb_partition_name, partition_method AS dbweb_partition_method,
              partition_expression AS dbweb_partition_expression,
              partition_description AS dbweb_partition_description
       FROM information_schema.partitions
       WHERE ${clauses.join(' AND ')}
       ORDER BY table_name, partition_ordinal_position`, values))
    return rows.map(mapPartitionObject)
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
    const sql = `SELECT ${columns.map((column) => quoteMysqlIdentifier(column.name)).join(', ')} FROM ${quoteMysqlIdentifier(table.schema)}.${quoteMysqlIdentifier(table.name)}`
    const stream = this.createRowStream(this.client, sql, [])
    const abortStream = () => stream.destroy(new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED'))
    signal.addEventListener('abort', abortStream, { once: true })
    const records = async function* (): AsyncIterable<ExactJsonRecord> {
      try {
        for await (const raw of stream) {
          throwIfAborted(signal)
          if (!raw || typeof raw !== 'object') failed()
          const row = raw as Record<string, unknown>
          const values: ExactJsonRecord['values'] = {}
          for (const column of columns) {
            if (!(column.name in row)) failed()
            values[column.name] = encodeDatabaseValue(row[column.name], column.type)
          }
          countRow()
          yield { kind: 'row', table: tableObjectId(table.schema, table.name), values }
        }
      } finally {
        signal.removeEventListener('abort', abortStream)
        if (!stream.readableEnded) stream.destroy()
      }
    }
    yield* encodeExactJson(manifest, records())
  }
}

interface MysqlTableRow { schema: string; name: string; engine: string; charset: string; collation: string }

const COLUMN_QUERY = `SELECT column_name AS dbweb_column_name, data_type AS dbweb_data_type,
       column_type AS dbweb_column_type, is_nullable AS dbweb_nullable,
       column_default AS dbweb_default, extra AS dbweb_extra
FROM information_schema.columns
WHERE table_schema = ? AND table_name = ?
ORDER BY ordinal_position`

const INDEX_QUERY = `SELECT index_name AS dbweb_index_name, non_unique AS dbweb_non_unique,
       index_type AS dbweb_method, column_name AS dbweb_column_name,
       seq_in_index AS dbweb_sequence, sub_part AS dbweb_prefix_length, collation AS dbweb_collation
FROM information_schema.statistics
WHERE table_schema = ? AND table_name = ?
ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`

const FOREIGN_KEY_QUERY = `SELECT tc.constraint_name AS dbweb_constraint_name,
       tc.constraint_type AS dbweb_constraint_type, kcu.column_name AS dbweb_columns,
       kcu.referenced_table_schema AS dbweb_reference_schema,
       kcu.referenced_table_name AS dbweb_reference_table,
       kcu.referenced_column_name AS dbweb_reference_columns,
       kcu.ordinal_position AS dbweb_ordinal_position,
       rc.update_rule AS dbweb_update_rule, rc.delete_rule AS dbweb_delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_schema = tc.constraint_schema
 AND kcu.table_name = tc.table_name
 AND kcu.constraint_name = tc.constraint_name
LEFT JOIN information_schema.referential_constraints rc
  ON rc.constraint_schema = tc.constraint_schema
 AND rc.constraint_name = tc.constraint_name
WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.constraint_name, kcu.ordinal_position`

const CHECK_QUERY = `SELECT tc.constraint_name AS dbweb_constraint_name,
       cc.check_clause AS dbweb_check_expression
FROM information_schema.table_constraints tc
JOIN information_schema.check_constraints cc
  ON cc.constraint_schema = tc.constraint_schema
 AND cc.constraint_name = tc.constraint_name
WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'
ORDER BY tc.constraint_name`

function mapColumn(row: Record<string, unknown>): DdlColumnDefinition {
  const dataType = requiredString(row.dbweb_data_type).toLowerCase()
  const columnType = requiredString(row.dbweb_column_type)
  const extra = String(row.dbweb_extra ?? '')
  const defaultValue = row.dbweb_default
  return {
    name: requiredString(row.dbweb_column_name),
    type: mapColumnType(dataType, columnType),
    nullable: row.dbweb_nullable === 'YES',
    ...(/auto_increment/i.test(extra) ? { identity: true } : {}),
    ...(defaultValue == null || /auto_increment|generated/i.test(extra) ? {} : { default: mapDefault(defaultValue) }),
  }
}

function mapColumnType(dataType: string, columnType: string): DdlColumnType {
  const length = /\((\d+)\)/.exec(columnType)?.[1]
  const numeric = /^(?:decimal|numeric)\((\d+),(\d+)\)/i.exec(columnType)
  if (dataType === 'bigint') return { name: 'bigint' }
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer'].includes(dataType)) return { name: 'integer' }
  if (dataType === 'float') return { name: 'float' }
  if (dataType === 'double') return { name: 'double' }
  if (dataType === 'decimal' || dataType === 'numeric') return { name: 'decimal', ...(numeric ? { precision: Number(numeric[1]), scale: Number(numeric[2]) } : {}) }
  if (dataType === 'varchar') return { name: 'varchar', ...(length ? { length: Number(length) } : {}) }
  if (dataType === 'char') return { name: 'char', ...(length ? { length: Number(length) } : {}) }
  if (dataType === 'binary' || dataType === 'varbinary') return { name: dataType, ...(length ? { length: Number(length) } : {}) }
  if (dataType === 'enum') return { name: 'enum', enumValues: parseMysqlEnum(columnType) }
  const allowed = new Set(['text', 'tinytext', 'mediumtext', 'longtext', 'date', 'time', 'datetime', 'timestamp', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'json'])
  if (!allowed.has(dataType)) failed()
  return { name: dataType }
}

function mapDefault(value: unknown): DdlDefault {
  if (typeof value === 'number' || typeof value === 'boolean') return { kind: 'literal', value }
  if (typeof value !== 'string') failed()
  if (/^CURRENT_(?:TIMESTAMP|DATE|TIME)(?:\(\))?$/i.test(value)) {
    return { kind: 'function', name: value.replace(/\(\)$/, '').toUpperCase() }
  }
  return { kind: 'literal', value }
}

function groupIndexes(rows: Array<Record<string, unknown>>): SqlDumpTableIndex[] {
  const grouped = new Map<string, SqlDumpTableIndex & { sequenced: Array<{ sequence: number; part: SqlDumpTableIndex['parts'][number] }> }>()
  for (const row of rows) {
    const name = requiredString(row.dbweb_index_name)
    const current = grouped.get(name) ?? {
      name, method: requiredString(row.dbweb_method).toLowerCase(), unique: Number(row.dbweb_non_unique) === 0,
      parts: [], sequenced: [],
    }
    const column = requiredString(row.dbweb_column_name)
    const prefix = row.dbweb_prefix_length == null ? undefined : Number(row.dbweb_prefix_length)
    current.sequenced.push({
      sequence: Number(row.dbweb_sequence),
      part: { column, order: row.dbweb_collation === 'D' ? 'desc' : 'asc', ...(prefix ? { prefixLength: prefix } : {}) },
    })
    grouped.set(name, current)
  }
  return [...grouped.values()].map(({ sequenced, ...index }) => ({
    ...index, parts: sequenced.sort((left, right) => left.sequence - right.sequence).map(({ part }) => part),
  }))
}

function groupForeignKeys(rows: Array<Record<string, unknown>>): SqlDumpTableConstraint[] {
  const grouped = new Map<string, {
    schema: string
    table: string
    onUpdate?: string
    onDelete?: string
    columns: Array<{ position: number; column: string; referenceColumn: string }>
  }>()
  for (const row of rows) {
    if (requiredString(row.dbweb_constraint_type) !== 'FOREIGN KEY') failed()
    const name = requiredString(row.dbweb_constraint_name)
    const current = grouped.get(name) ?? {
      schema: requiredString(row.dbweb_reference_schema),
      table: requiredString(row.dbweb_reference_table),
      ...referentialAction('onUpdate', row.dbweb_update_rule),
      ...referentialAction('onDelete', row.dbweb_delete_rule),
      columns: [],
    }
    current.columns.push({
      position: Number(row.dbweb_ordinal_position ?? 1),
      column: requiredString(row.dbweb_columns),
      referenceColumn: requiredString(row.dbweb_reference_columns),
    })
    grouped.set(name, current)
  }
  return [...grouped.entries()].map(([name, value]) => {
    const columns = value.columns.sort((left, right) => left.position - right.position)
    return {
      name,
      constraint: {
        kind: 'foreign-key' as const,
        columns: columns.map((column) => column.column),
        referenceSchema: value.schema,
        referenceTable: value.table,
        referenceColumns: columns.map((column) => column.referenceColumn),
        ...(value.onUpdate ? { onUpdate: value.onUpdate } : {}),
        ...(value.onDelete ? { onDelete: value.onDelete } : {}),
      },
    }
  })
}

function referentialAction(
  key: 'onUpdate' | 'onDelete',
  value: unknown,
): { onUpdate?: string; onDelete?: string } {
  const action = requiredString(value).toLowerCase()
  if (!['no action', 'restrict', 'cascade', 'set null'].includes(action)) failed()
  return { [key]: action }
}

function mapViewObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_view_schema)
  const name = requiredString(row.dbweb_view_name)
  const dependenciesValue = row.dbweb_dependencies
  const dependencies = dependenciesValue == null || dependenciesValue === ''
    ? []
    : requiredString(dependenciesValue).split(',')
  return {
    id: `view:${schema}.${name}`, kind: 'view', schema, name, dependencies,
    createCommands: [{
      kind: 'create-view', schema, name,
      query: requiredString(row.dbweb_view_definition).trim(), confirmed: true,
    }],
    dropCommand: { kind: 'drop-view', schema, name, confirmed: true },
  }
}

function mapRoutineObject(
  row: Record<string, unknown>,
  parameterRows: Array<Record<string, unknown>>,
  routineType: string,
): SqlDumpObject {
  const schema = requiredString(row.dbweb_routine_schema)
  const name = requiredString(row.dbweb_routine_name)
  const routineKind = routineType === 'FUNCTION' ? 'function' as const
    : routineType === 'PROCEDURE' ? 'procedure' as const : failed()
  const argumentsValue = parameterRows
    .filter((parameter) => Number(parameter.dbweb_parameter_position) > 0)
    .map(mapRoutineArgument)
  const returnType = row.dbweb_return_type == null ? undefined : mapMysqlFormattedType(requiredString(row.dbweb_return_type))
  if (routineKind === 'function' && !returnType) failed()
  const dataAccess = mapMysqlDataAccess(row.dbweb_data_access)
  const security = requiredString(row.dbweb_security).toLowerCase()
  if (security !== 'invoker' && security !== 'definer') failed()
  return {
    id: `${routineKind}:${schema}.${name}`, kind: routineKind, schema, name, dependencies: [],
    createCommands: [{
      kind: 'create-routine', routineKind, schema, name, arguments: argumentsValue,
      ...(returnType ? { returns: returnType } : {}),
      body: requiredString(row.dbweb_body).trim(),
      deterministic: requiredString(row.dbweb_deterministic) === 'YES',
      dataAccess,
      security,
      confirmed: true,
    }],
    dropCommand: { kind: 'drop-routine', routineKind, schema, name, argumentTypes: [], confirmed: true },
  }
}

function mapRoutineArgument(row: Record<string, unknown>): DdlRoutineArgument {
  const mode = requiredString(row.dbweb_parameter_mode).toLowerCase()
  if (mode !== 'in' && mode !== 'out' && mode !== 'inout') failed()
  const name = row.dbweb_parameter_name == null ? undefined : requiredString(row.dbweb_parameter_name)
  return {
    ...(name ? { name } : {}), mode,
    type: mapMysqlFormattedType(requiredString(row.dbweb_parameter_type)),
  }
}

function mapMysqlFormattedType(value: string): DdlColumnType {
  const normalized = value.toLowerCase().trim()
  const dataType = /^([a-z]+(?:\s+[a-z]+)?)/.exec(normalized)?.[1]
  if (!dataType) failed()
  return mapColumnType(dataType === 'int' ? 'int' : dataType, normalized)
}

function mapMysqlDataAccess(value: unknown): 'no-sql' | 'contains-sql' | 'reads-sql-data' | 'modifies-sql-data' {
  const normalized = requiredString(value).toUpperCase()
  const values = {
    'NO SQL': 'no-sql', 'CONTAINS SQL': 'contains-sql',
    'READS SQL DATA': 'reads-sql-data', 'MODIFIES SQL DATA': 'modifies-sql-data',
  } as const
  const mapped = values[normalized as keyof typeof values]
  if (!mapped) failed()
  return mapped
}

function mapTriggerObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_trigger_schema)
  const table = requiredString(row.dbweb_trigger_table)
  const name = requiredString(row.dbweb_trigger_name)
  const timing = requiredString(row.dbweb_trigger_timing).toLowerCase()
  const event = requiredString(row.dbweb_trigger_event).toLowerCase()
  if ((timing !== 'before' && timing !== 'after') || !['insert', 'update', 'delete'].includes(event)) failed()
  return {
    id: `trigger:${schema}.${table}.${name}`, kind: 'trigger', schema, name,
    dependencies: [`table:${schema}.${table}`],
    createCommands: [{
      kind: 'create-trigger', schema, table, name, timing,
      events: [event as 'insert' | 'update' | 'delete'], forEach: 'row',
      body: requiredString(row.dbweb_trigger_body).trim(), confirmed: true,
    }],
    dropCommand: { kind: 'drop-trigger', schema, table, name, confirmed: true },
  }
}

function mapEventObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_event_schema)
  const name = requiredString(row.dbweb_event_name)
  const schedule = mapEventSchedule(row)
  const status = requiredString(row.dbweb_status).toUpperCase()
  if (!['ENABLED', 'DISABLED', 'SLAVESIDE_DISABLED'].includes(status)) failed()
  return {
    id: `event:${schema}.${name}`, kind: 'event', schema, name, dependencies: [],
    createCommands: [{
      kind: 'create-event', schema, name, schedule,
      preserve: requiredString(row.dbweb_on_completion).toUpperCase() === 'PRESERVE',
      enabled: status === 'ENABLED', body: requiredString(row.dbweb_event_body).trim(), confirmed: true,
    }],
    dropCommand: { kind: 'drop-event', schema, name, confirmed: true },
  }
}

function mapEventSchedule(row: Record<string, unknown>): DdlEventSchedule {
  if (row.dbweb_execute_at != null) {
    const at = row.dbweb_execute_at instanceof Date
      ? row.dbweb_execute_at.toISOString().replace('T', ' ').replace(/\.000Z$/, '')
      : requiredString(row.dbweb_execute_at)
    return { kind: 'at', at }
  }
  const amount = Number(row.dbweb_interval_value)
  const unit = requiredString(row.dbweb_interval_field).toLowerCase()
  if (!Number.isSafeInteger(amount) || amount < 1 || !['second', 'minute', 'hour', 'day', 'week', 'month', 'year'].includes(unit)) failed()
  return { kind: 'every', amount, unit: unit as Extract<DdlEventSchedule, { kind: 'every' }>['unit'] }
}

function mapPartitionObject(row: Record<string, unknown>): SqlDumpObject {
  const schema = requiredString(row.dbweb_partition_schema)
  const table = requiredString(row.dbweb_partition_table)
  const name = requiredString(row.dbweb_partition_name)
  const method = requiredString(row.dbweb_partition_method).toUpperCase()
  const description = requiredString(row.dbweb_partition_description)
  const definition = method === 'RANGE' ? `VALUES LESS THAN (${description})`
    : method === 'LIST' ? `VALUES IN (${description})` : failed()
  return {
    id: `partition:${schema}.${table}.${name}`, kind: 'partition', schema, name,
    dependencies: [`table:${schema}.${table}`],
    createCommands: [{ kind: 'create-partition', schema, table, name, definition, confirmed: true }],
    dropCommand: { kind: 'drop-partition', schema, table, name, confirmed: true },
  }
}

function parseServerVersion(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) failed()
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(
  actual: readonly [number, number, number],
  required: readonly [number, number, number],
): boolean {
  return actual[0] > required[0]
    || (actual[0] === required[0] && actual[1] > required[1])
    || (actual[0] === required[0] && actual[1] === required[1] && actual[2] >= required[2])
}

function requiredColumnPart(part: SqlDumpTableIndex['parts'][number]): string {
  if (!part.column || part.expression) failed()
  return part.column
}

function parseMysqlEnum(columnType: string): string[] {
  const match = /^enum\((.*)\)$/is.exec(columnType)
  if (!match) failed()
  const values: string[] = []
  const pattern = /'((?:''|\\.|[^'])*)'(?:,|$)/g
  let consumed = 0
  for (const item of match[1]!.matchAll(pattern)) {
    if (item.index !== consumed) failed()
    values.push(item[1]!.replaceAll("''", "'").replace(/\\(.)/g, '$1'))
    consumed = item.index + item[0].length
  }
  if (values.length === 0 || consumed !== match[1]!.length) failed()
  return values
}

function valueTypeForColumn(column: DdlColumnDefinition): DatabaseValueType {
  const name = column.type.name.toLowerCase()
  if (name === 'bigint') return 'bigint'
  if (['integer', 'float', 'double'].includes(name)) return 'number'
  if (name === 'decimal' || name === 'numeric') return 'decimal'
  if (name === 'date') return 'date'
  if (name === 'time') return 'time'
  if (name === 'datetime' || name === 'timestamp') return 'datetime'
  if (['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(name)) return 'binary'
  if (name === 'json') return 'json'
  if (name === 'enum') return 'enum'
  if (['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(name)) return 'string'
  failed()
}

async function connectMysql(options: Parameters<MysqlSqlDumpConnectionFactory>[0]): Promise<MysqlSqlDumpConnection> {
  const client = mysql.createConnection(options as ConnectionOptions) as unknown as MysqlSqlDumpConnection & {
    connect(callback: (error?: Error) => void): void
  }
  await new Promise<void>((resolve, reject) => client.connect((error) => error ? reject(error) : resolve()))
  return client
}

function query(client: MysqlSqlDumpConnection, sql: string, values: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows))
  })
}

function end(client?: MysqlSqlDumpConnection): Promise<void> {
  if (!client) return Promise.resolve()
  return new Promise((resolve, reject) => client.end((error) => error ? reject(error) : resolve()))
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) failed()
  return value as Array<Record<string, unknown>>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) failed()
  return value
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) failed()
}

function failed(): never {
  throw new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED')
}
