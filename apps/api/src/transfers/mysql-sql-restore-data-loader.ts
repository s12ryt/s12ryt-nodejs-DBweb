import { quoteMysqlIdentifier } from '../data/mutation-sql.js'
import { applyTransferMapping } from './transfer-column-mapping.js'
import { decodeExactJson } from './exact-json-format.js'
import { buildMysqlImportStatements } from './exact-json-import-sql.js'
import type { MysqlSqlRestoreConnection } from './mysql-sql-restore-gateway.js'
import type { SqlDumpObject } from './sql-dump-manifest.js'
import { buildSqlRestoreDataPlan } from './sql-restore-data-plan.js'
import { SqlRestoreExecutionError } from './sql-restore-service.js'

export async function loadMysqlSqlDumpData(
  client: MysqlSqlRestoreConnection,
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
      for (const statement of buildMysqlImportStatements(plan, values)) {
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
  client: MysqlSqlRestoreConnection,
  plan: ReturnType<typeof buildSqlRestoreDataPlan>,
): Promise<void> {
  if (!plan.conflict.preserveIdentity) return
  const identity = plan.conflict.identity?.columns.find((name) =>
    plan.target.columns.some((column) => column.name === name && column.generated))
  if (!identity) return
  const table = `${quoteMysqlIdentifier(plan.target.schema)}.${quoteMysqlIdentifier(plan.target.name)}`
  const column = quoteMysqlIdentifier(identity)
  const [rawRows] = await client.query(`SELECT COALESCE(MAX(${column}), 0) + 1 AS dbweb_next FROM ${table}`)
  if (!Array.isArray(rawRows)) changed()
  const next = (rawRows[0] as Record<string, unknown> | undefined)?.dbweb_next
  const literal = typeof next === 'bigint' ? next.toString() : String(next)
  if (!/^[1-9][0-9]*$/.test(literal)) changed()
  await client.query(`ALTER TABLE ${table} AUTO_INCREMENT = ${literal}`)
}

function changed(): never {
  throw new SqlRestoreExecutionError('RESTORE_CHANGED')
}
