import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { TransferFilter } from './transfer-filter.js'

export type TransferDataRow = Record<string, TaggedDatabaseValue>

export interface TransferDataRequest {
  table: MutationTable
  filters: TransferFilter[]
  batchSize: number
  signal?: AbortSignal
}

export interface TransferDataGateway {
  stream(
    connection: ResolvedConnection,
    request: TransferDataRequest,
  ): AsyncIterable<TransferDataRow>
}

export type TransferDataErrorCode =
  | 'INVALID_TRANSFER_DATA'
  | 'TRANSFER_DATA_CANCELLED'
  | 'TRANSFER_DATA_FAILED'

export class TransferDataError extends Error {
  constructor(readonly code: TransferDataErrorCode) {
    super(code)
    this.name = 'TransferDataError'
  }
}
