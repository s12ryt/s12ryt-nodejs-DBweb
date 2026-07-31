import type { MutationTable } from '../data/row-write-policy.js'
import { decodeMutationValue, type TaggedDatabaseValue } from '../data/tagged-value.js'
import { quoteMysqlIdentifier, quotePostgresIdentifier } from '../data/mutation-sql.js'

type ComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like'

export type TransferFilter =
  | { column: string; operator: ComparisonOperator; value: TaggedDatabaseValue }
  | { column: string; operator: 'is-null' | 'is-not-null' }
  | { column: string; operator: 'in'; values: TaggedDatabaseValue[] }
  | { column: string; operator: 'between'; values: TaggedDatabaseValue[] }

export interface BuiltTransferFilter {
  sql: string
  values: unknown[]
}

export class TransferFilterError extends Error {
  constructor(readonly code: 'INVALID_TRANSFER_FILTER') {
    super(code)
    this.name = 'TransferFilterError'
  }
}

export function buildPostgresTransferFilter(
  table: MutationTable,
  filters: TransferFilter[],
): BuiltTransferFilter {
  return buildTransferFilter(table, filters, {
    quote: quotePostgresIdentifier,
    parameter: (index) => `$${index}`,
  })
}

export function buildMysqlTransferFilter(
  table: MutationTable,
  filters: TransferFilter[],
): BuiltTransferFilter {
  return buildTransferFilter(table, filters, {
    quote: quoteMysqlIdentifier,
    parameter: () => '?',
  })
}

interface FilterDialect {
  quote(value: string): string
  parameter(index: number): string
}

function buildTransferFilter(
  table: MutationTable,
  filters: TransferFilter[],
  dialect: FilterDialect,
): BuiltTransferFilter {
  if (!Array.isArray(filters) || filters.length > 100) invalidFilter()
  const columns = new Map(table.columns.map((column) => [column.name, column]))
  const values: unknown[] = []
  const parameter = (value: TaggedDatabaseValue, expectedType: string): string => {
    if (value.kind !== 'value' || value.type !== expectedType) invalidFilter()
    let decoded: unknown
    try {
      decoded = decodeMutationValue(value)
    } catch {
      invalidFilter()
    }
    values.push(decoded)
    return dialect.parameter(values.length)
  }

  const clauses = filters.map((filter) => {
    const column = columns.get(filter.column)
    if (!column || column.valueType === 'unsupported') invalidFilter()
    const quoted = dialect.quote(column.name)

    switch (filter.operator) {
      case 'is-null':
        return `${quoted} IS NULL`
      case 'is-not-null':
        return `${quoted} IS NOT NULL`
      case 'between': {
        if (filter.values.length !== 2) invalidFilter()
        const lower = parameter(filter.values[0]!, column.valueType)
        const upper = parameter(filter.values[1]!, column.valueType)
        return `${quoted} BETWEEN ${lower} AND ${upper}`
      }
      case 'in': {
        if (filter.values.length < 1 || filter.values.length > 100) invalidFilter()
        const parameters = filter.values.map((value) => parameter(value, column.valueType))
        return `${quoted} IN (${parameters.join(', ')})`
      }
      case 'like':
        if (!['string', 'enum', 'uuid'].includes(column.valueType)) invalidFilter()
        return `${quoted} LIKE ${parameter(filter.value, column.valueType)}`
      default: {
        const operator = {
          eq: '=',
          ne: '<>',
          lt: '<',
          lte: '<=',
          gt: '>',
          gte: '>=',
        }[filter.operator]
        return `${quoted} ${operator} ${parameter(filter.value, column.valueType)}`
      }
    }
  })

  return { sql: clauses.join(' AND '), values }
}

function invalidFilter(): never {
  throw new TransferFilterError('INVALID_TRANSFER_FILTER')
}
