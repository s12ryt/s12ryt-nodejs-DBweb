import { describe, expect, it } from 'vitest'

import type { MutationTable } from '../data/row-write-policy.js'
import {
  TransferImportPlanError,
  buildTransferImportPlan,
} from './transfer-import-plan.js'

const keyedTable: MutationTable = {
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: true },
    { name: 'email', valueType: 'string', nullable: false, generated: false },
    { name: 'note', valueType: 'string', nullable: true, generated: false },
  ],
  uniqueKeys: [
    { kind: 'primary', name: 'orders_pkey', columns: ['id'] },
    { kind: 'unique', name: 'orders_email_key', columns: ['email'] },
  ],
}

const unkeyedTable: MutationTable = {
  ...keyedTable,
  uniqueKeys: [],
}

describe('transfer import plans', () => {
  it('defaults to skip conflicts and batches of 1000 without preserving identities', () => {
    expect(buildTransferImportPlan(keyedTable, {})).toEqual({
      conflict: 'skip',
      transaction: 'batch',
      batchSize: 1_000,
      identity: { kind: 'primary', name: 'orders_pkey', columns: ['id'] },
      preserveIdentity: false,
      resumed: false,
    })
  })

  it('allows atomic updates and confirmed transactional replacement with a stable key', () => {
    expect(buildTransferImportPlan(keyedTable, {
      conflict: 'update', transaction: 'atomic', preserveIdentity: true,
    })).toMatchObject({ conflict: 'update', transaction: 'atomic', identity: { columns: ['id'] } })

    expect(buildTransferImportPlan(keyedTable, {
      conflict: 'replace', confirmedReplace: true, transaction: 'batch', batchSize: 10_000,
    })).toMatchObject({ conflict: 'replace', batchSize: 10_000 })
  })

  it('forces failed batch resumes to skip existing stable identities', () => {
    expect(buildTransferImportPlan(keyedTable, {
      conflict: 'replace',
      confirmedReplace: true,
      transaction: 'batch',
      batchSize: 500,
      resume: true,
    })).toEqual({
      conflict: 'skip',
      transaction: 'batch',
      batchSize: 500,
      identity: { kind: 'primary', name: 'orders_pkey', columns: ['id'] },
      preserveIdentity: false,
      resumed: true,
    })
  })

  it('rejects unstable update/replace/resume, unconfirmed replace, invalid batches, and atomic resume', () => {
    const cases = [
      () => buildTransferImportPlan(unkeyedTable, { conflict: 'update' }),
      () => buildTransferImportPlan(unkeyedTable, { conflict: 'replace', confirmedReplace: true }),
      () => buildTransferImportPlan(unkeyedTable, { resume: true }),
      () => buildTransferImportPlan(keyedTable, { conflict: 'replace' }),
      () => buildTransferImportPlan(keyedTable, { batchSize: 99 }),
      () => buildTransferImportPlan(keyedTable, { batchSize: 10_001 }),
      () => buildTransferImportPlan(keyedTable, { transaction: 'atomic', resume: true }),
    ]
    for (const run of cases) expect(run).toThrow(TransferImportPlanError)
  })
})
