import {
  type DataMutationOperation,
  type MutationValues,
} from './data-mutation-service.js'
import { DEFAULT_VALUE, decodeMutationValue } from './tagged-value.js'

export type SingularMutationOperation = Exclude<DataMutationOperation, { kind: 'batch-update' }>

export interface BuiltMutation {
  sql: string
  values: unknown[]
  kind: SingularMutationOperation['kind']
}

export function expandMutationOperations(
  operations: DataMutationOperation[],
): SingularMutationOperation[] {
  return operations.flatMap((operation) =>
    operation.kind === 'batch-update'
      ? operation.rows.map((row) => ({ kind: 'update' as const, ...row, patch: operation.patch }))
      : [operation],
  )
}

export function buildPostgresMutation(
  schema: string,
  table: string,
  operation: SingularMutationOperation,
  returningColumn?: string,
): BuiltMutation {
  return buildMutation(schema, table, operation, {
    quote: quotePostgresIdentifier,
    parameter: (index) => `$${index}`,
    whereEquals: (column, parameter) => `${column} = ${parameter}`,
    returning: returningColumn ? ` RETURNING ${quotePostgresIdentifier(returningColumn)}` : '',
  })
}

export function buildMysqlMutation(
  schema: string,
  table: string,
  operation: SingularMutationOperation,
): BuiltMutation {
  return buildMutation(schema, table, operation, {
    quote: quoteMysqlIdentifier,
    parameter: () => '?',
    whereEquals: (column, parameter) => `${column} = ${parameter}`,
    returning: '',
  })
}

interface SqlDialect {
  quote(value: string): string
  parameter(index: number): string
  whereEquals(column: string, parameter: string): string
  returning: string
}

function buildMutation(
  schema: string,
  table: string,
  operation: SingularMutationOperation,
  dialect: SqlDialect,
): BuiltMutation {
  const target = `${dialect.quote(schema)}.${dialect.quote(table)}`
  const values: unknown[] = []
  const parameter = (value: unknown) => {
    values.push(value)
    return dialect.parameter(values.length)
  }

  if (operation.kind === 'insert') {
    const entries = Object.entries(operation.values)
    if (entries.length === 0) {
      return {
        kind: operation.kind,
        sql: `INSERT INTO ${target} DEFAULT VALUES${dialect.returning}`,
        values,
      }
    }
    const columns = entries.map(([name]) => dialect.quote(name)).join(', ')
    const placeholders = entries.map(([, tagged]) => {
      const decoded = decodeMutationValue(tagged)
      return decoded === DEFAULT_VALUE ? 'DEFAULT' : parameter(decoded)
    }).join(', ')
    return {
      kind: operation.kind,
      sql: `INSERT INTO ${target} (${columns}) VALUES (${placeholders})${dialect.returning}`,
      values,
    }
  }

  if (operation.kind === 'delete') {
    const where = buildWhere(operation.identity, operation.original, dialect, parameter)
    return { kind: operation.kind, sql: `DELETE FROM ${target} WHERE ${where}`, values }
  }

  const assignments = Object.entries(operation.patch).map(([name, tagged]) => {
    const decoded = decodeMutationValue(tagged)
    return `${dialect.quote(name)} = ${decoded === DEFAULT_VALUE ? 'DEFAULT' : parameter(decoded)}`
  }).join(', ')
  const where = buildWhere(operation.identity, operation.original, dialect, parameter)
  return {
    kind: operation.kind,
    sql: `UPDATE ${target} SET ${assignments} WHERE ${where}`,
    values,
  }
}

function buildWhere(
  identity: MutationValues,
  original: MutationValues,
  dialect: SqlDialect,
  parameter: (value: unknown) => string,
): string {
  return [...Object.entries(identity), ...Object.entries(original)].map(([name, tagged]) => {
    const column = dialect.quote(name)
    const decoded = decodeMutationValue(tagged)
    return decoded === null
      ? `${column} IS NULL`
      : dialect.whereEquals(column, parameter(decoded))
  }).join(' AND ')
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}
