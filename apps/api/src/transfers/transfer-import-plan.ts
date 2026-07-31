import { buildRowWritePolicy, type MutationTable, type MutationUniqueKey } from '../data/row-write-policy.js'

export type TransferConflictStrategy = 'skip' | 'update' | 'replace'
export type TransferTransactionMode = 'atomic' | 'batch'

export interface TransferImportPlanInput {
  conflict?: TransferConflictStrategy
  transaction?: TransferTransactionMode
  batchSize?: number
  preserveIdentity?: boolean
  confirmedReplace?: boolean
  resume?: boolean
}

export interface TransferImportPlan {
  conflict: TransferConflictStrategy
  transaction: TransferTransactionMode
  batchSize: number
  identity: MutationUniqueKey | null
  preserveIdentity: boolean
  resumed: boolean
}

export class TransferImportPlanError extends Error {
  constructor(readonly code: 'INVALID_IMPORT_PLAN' | 'REPLACE_CONFIRMATION_REQUIRED') {
    super(code)
    this.name = 'TransferImportPlanError'
  }
}

export function buildTransferImportPlan(
  table: MutationTable,
  input: TransferImportPlanInput,
): TransferImportPlan {
  const conflict = input.conflict ?? 'skip'
  const transaction = input.transaction ?? 'batch'
  const batchSize = input.batchSize ?? 1_000
  const resumed = input.resume === true
  if (!['skip', 'update', 'replace'].includes(conflict)) invalidPlan()
  if (!['atomic', 'batch'].includes(transaction)) invalidPlan()
  if (!Number.isSafeInteger(batchSize) || batchSize < 100 || batchSize > 10_000) invalidPlan()
  if (resumed && transaction !== 'batch') invalidPlan()

  const identity = buildRowWritePolicy(table).identity
  if ((conflict === 'update' || conflict === 'replace' || resumed) && !identity) invalidPlan()
  if (conflict === 'replace' && input.confirmedReplace !== true) {
    throw new TransferImportPlanError('REPLACE_CONFIRMATION_REQUIRED')
  }
  if (input.preserveIdentity === true) {
    const generatedIdentity = identity?.columns.some((name) =>
      table.columns.some((column) => column.name === name && column.generated))
    if (!generatedIdentity) invalidPlan()
  }

  return {
    conflict: resumed ? 'skip' : conflict,
    transaction,
    batchSize,
    identity,
    preserveIdentity: resumed ? false : input.preserveIdentity === true,
    resumed,
  }
}

function invalidPlan(): never {
  throw new TransferImportPlanError('INVALID_IMPORT_PLAN')
}
