import type { MutationUniqueKey } from '../data/row-write-policy.js'
import { DEFAULT_VALUE, decodeMutationValue, type TaggedDatabaseValue } from '../data/tagged-value.js'
import { quoteMysqlIdentifier, quotePostgresIdentifier } from '../data/mutation-sql.js'
import type { ExactJsonImportTablePlan } from './exact-json-import-service.js'

export interface ImportStatement {
  sql: string
  values: unknown[]
  operation: 'insert' | 'upsert' | 'delete'
}

export function buildPostgresImportStatements(
  plan: ExactJsonImportTablePlan,
  values: Record<string, TaggedDatabaseValue>,
): ImportStatement[] {
  return buildImportStatements(plan, values, {
    quote: quotePostgresIdentifier,
    parameter: (index) => `$${index}`,
    skipSuffix: ' ON CONFLICT DO NOTHING',
    updateSuffix: (identity, columns) =>
      ` ON CONFLICT (${identity.columns.map(quotePostgresIdentifier).join(', ')}) DO UPDATE SET ${columns.map((name) => `${quotePostgresIdentifier(name)} = EXCLUDED.${quotePostgresIdentifier(name)}`).join(', ')} RETURNING (xmax = 0) AS dbweb_inserted`,
  })
}

export function buildMysqlImportStatements(
  plan: ExactJsonImportTablePlan,
  values: Record<string, TaggedDatabaseValue>,
): ImportStatement[] {
  return buildImportStatements(plan, values, {
    quote: quoteMysqlIdentifier,
    parameter: () => '?',
    skipPrefix: 'INSERT IGNORE',
    updateSuffix: (_identity, columns) =>
      ` ON DUPLICATE KEY UPDATE ${columns.map((name) => `${quoteMysqlIdentifier(name)} = VALUES(${quoteMysqlIdentifier(name)})`).join(', ')}`,
  })
}

interface ImportDialect {
  quote(value: string): string
  parameter(index: number): string
  skipPrefix?: string
  skipSuffix?: string
  updateSuffix(identity: MutationUniqueKey, columns: string[]): string
}

function buildImportStatements(
  plan: ExactJsonImportTablePlan,
  taggedValues: Record<string, TaggedDatabaseValue>,
  dialect: ImportDialect,
): ImportStatement[] {
  const columnByName = new Map(plan.target.columns.map((column) => [column.name, column]))
  const entries = plan.target.columns.flatMap((column) => {
    const tagged = taggedValues[column.name]
    if (!tagged) return []
    if (column.valueType === 'unsupported') invalidImport()
    if (column.generated && !plan.conflict.preserveIdentity) return []
    return [[column.name, tagged] as const]
  })
  if (entries.length === 0) invalidImport()
  if (Object.keys(taggedValues).some((name) => !columnByName.has(name))) invalidImport()

  const target = `${dialect.quote(plan.target.schema)}.${dialect.quote(plan.target.name)}`
  const insertValues: unknown[] = []
  const placeholders = entries.map(([, tagged]) => {
    const decoded = decodeMutationValue(tagged)
    if (decoded === DEFAULT_VALUE) return 'DEFAULT'
    insertValues.push(decoded)
    return dialect.parameter(insertValues.length)
  })
  const insertPrefix = plan.conflict.conflict === 'skip' && dialect.skipPrefix
    ? dialect.skipPrefix
    : 'INSERT'
  let sql = `${insertPrefix} INTO ${target} (${entries.map(([name]) => dialect.quote(name)).join(', ')}) VALUES (${placeholders.join(', ')})`

  if (plan.conflict.conflict === 'skip') sql += dialect.skipSuffix ?? ''
  if (plan.conflict.conflict === 'update') {
    const identity = requiredIdentity(plan)
    const updatedColumns = entries.map(([name]) => name).filter((name) => !identity.columns.includes(name))
    if (updatedColumns.length === 0) invalidImport()
    sql += dialect.updateSuffix(identity, updatedColumns)
  }
  const insert: ImportStatement = {
    sql, values: insertValues,
    operation: plan.conflict.conflict === 'update' ? 'upsert' : 'insert',
  }
  if (plan.conflict.conflict !== 'replace') return [insert]

  const identity = requiredIdentity(plan)
  const deleteValues: unknown[] = []
  const predicates = identity.columns.map((name) => {
    const tagged = taggedValues[name]
    if (!tagged) invalidImport()
    const decoded = decodeMutationValue(tagged)
    if (decoded === DEFAULT_VALUE || decoded === null) invalidImport()
    deleteValues.push(decoded)
    return `${dialect.quote(name)} = ${dialect.parameter(deleteValues.length)}`
  })
  return [
    { sql: `DELETE FROM ${target} WHERE ${predicates.join(' AND ')}`, values: deleteValues, operation: 'delete' },
    { ...insert, operation: 'insert' },
  ]
}

function requiredIdentity(plan: ExactJsonImportTablePlan): MutationUniqueKey {
  if (!plan.conflict.identity) invalidImport()
  return plan.conflict.identity
}

function invalidImport(): never {
  throw new Error('INVALID_IMPORT_DATA')
}
