import type { PostgresClientLike } from '../connections/postgres-connector.js'
import { applyTransferMapping } from './transfer-column-mapping.js'
import { decodeExactJson } from './exact-json-format.js'
import { buildPostgresImportStatements } from './exact-json-import-sql.js'
import type { SqlDumpObject } from './sql-dump-manifest.js'
import { buildSqlRestoreDataPlan } from './sql-restore-data-plan.js'
import { SqlRestoreExecutionError } from './sql-restore-service.js'

export async function loadPostgresSqlDumpData(
  client: PostgresClientLike,
  object: SqlDumpObject,
  _entryPath: string,
  content: AsyncIterable<Buffer>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const decoded = await decodeExactJson(content)
    if (decoded.manifest.tables.length !== 1) changed()
    const plan = buildSqlRestoreDataPlan(object, decoded.manifest.tables[0]!)
    for await (const record of decoded.records) {
      if (signal.aborted) throw new SqlRestoreExecutionError('RESTORE_CANCELLED')
      const values = applyTransferMapping(record.values, plan.mapping)
      for (const statement of buildPostgresImportStatements(plan, values)) {
        await client.query(statement.sql, statement.values)
      }
    }
    await synchronizeIdentity(client, plan)
  } catch (error) {
    if (error instanceof SqlRestoreExecutionError) throw error
    throw new SqlRestoreExecutionError('RESTORE_CHANGED')
  }
}

async function synchronizeIdentity(
  client: PostgresClientLike,
  plan: ReturnType<typeof buildSqlRestoreDataPlan>,
): Promise<void> {
  if (!plan.conflict.preserveIdentity) return
  const identity = plan.conflict.identity?.columns.find((name) =>
    plan.target.columns.some((column) => column.name === name && column.generated))
  if (!identity) return
  const sequence = await client.query(
    'SELECT pg_get_serial_sequence($1, $2) AS dbweb_sequence',
    [`${plan.target.schema}.${plan.target.name}`, identity],
  )
  const sequenceName = sequence.rows[0]?.dbweb_sequence
  if (typeof sequenceName !== 'string') return
  const table = `"${plan.target.schema.replaceAll('"', '""')}"."${plan.target.name.replaceAll('"', '""')}"`
  const column = `"${identity.replaceAll('"', '""')}"`
  await client.query(
    `SELECT setval($1::regclass, COALESCE(MAX(${column}), 1), COUNT(*) > 0) FROM ${table}`,
    [sequenceName],
  )
}

function changed(): never {
  throw new SqlRestoreExecutionError('RESTORE_CHANGED')
}
