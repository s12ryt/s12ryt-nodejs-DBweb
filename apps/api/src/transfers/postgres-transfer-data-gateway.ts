import type { Duplex } from 'node:stream'

import { Client, type ClientConfig } from 'pg'
import Cursor from 'pg-cursor'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { postgresClientConfig } from '../connections/postgres-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { quotePostgresIdentifier } from '../data/mutation-sql.js'
import { encodeDatabaseValue } from '../data/tagged-value.js'
import {
  TransferDataError,
  type TransferDataGateway,
  type TransferDataBatchRequest,
  type TransferDataBatchRow,
  type TransferDataRequest,
  type TransferDataRow,
} from './transfer-data-gateway.js'
import { buildPostgresTransferFilter } from './transfer-filter.js'

export interface PostgresTransferCursor {
  read(maxRows: number): Promise<Array<Record<string, unknown>>>
  close(): Promise<void>
}

export interface PostgresTransferClient {
  connect(): Promise<unknown>
  query(sql: string, values?: unknown[]): Promise<unknown>
  query(cursor: PostgresTransferCursor): PostgresTransferCursor
  end(): Promise<void>
}

export type PostgresTransferClientFactory = (config: ClientConfig) => PostgresTransferClient
export type PostgresTransferCursorFactory = (
  sql: string,
  values: unknown[],
) => PostgresTransferCursor

export class PostgresTransferDataGateway implements TransferDataGateway {
  constructor(
    private readonly createClient: PostgresTransferClientFactory = (config) =>
      new Client(config) as unknown as PostgresTransferClient,
    private readonly createCursor: PostgresTransferCursorFactory = (sql, values) =>
      new Cursor<Record<string, unknown>>(sql, values),
    private readonly socketProvider?: DatabaseSocketProvider,
  ) {}

  async *stream(
    connection: ResolvedConnection,
    request: TransferDataRequest,
  ): AsyncIterable<TransferDataRow> {
    for await (const item of this.streamMany(connection, [{ id: 'single', request }])) {
      yield item.row
    }
  }

  async *streamMany(
    connection: ResolvedConnection,
    requests: TransferDataBatchRequest[],
  ): AsyncIterable<TransferDataBatchRow> {
    validateRequests(requests)
    let client: PostgresTransferClient | undefined
    let cursor: PostgresTransferCursor | undefined
    let socket: Duplex | undefined
    let committed = false
    let exhausted = false
    let currentSignal: AbortSignal | undefined
    const abortCursor = () => {
      void cursor?.close().catch(() => undefined)
    }

    try {
      socket = await this.socketProvider?.open(connection)
      client = this.createClient(postgresClientConfig(connection, socket))
      await client.connect()
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

      for (const batch of requests) {
        const request = batch.request
        throwIfAborted(request.signal)
        const filter = buildPostgresTransferFilter(request.table, request.filters)
        const columns = request.table.columns.map((column) => quotePostgresIdentifier(column.name))
        const sql = `SELECT ${columns.join(', ')} FROM ${quotePostgresIdentifier(request.table.schema)}.${quotePostgresIdentifier(request.table.name)}${filter.sql ? ` WHERE ${filter.sql}` : ''}`
        cursor = client.query(this.createCursor(sql, filter.values))
        exhausted = false
        currentSignal = request.signal
        currentSignal?.addEventListener('abort', abortCursor, { once: true })

        while (true) {
          throwIfAborted(request.signal)
          const rows = await cursor.read(request.batchSize)
          throwIfAborted(request.signal)
          if (rows.length === 0) {
            exhausted = true
            break
          }
          for (const row of rows) yield { id: batch.id, row: encodeRow(row, request) }
        }
        currentSignal?.removeEventListener('abort', abortCursor)
        currentSignal = undefined
        cursor = undefined
      }

      await client.query('COMMIT')
      committed = true
    } catch (error) {
      if (error instanceof TransferDataError) throw error
      throw new TransferDataError('TRANSFER_DATA_FAILED')
    } finally {
      currentSignal?.removeEventListener('abort', abortCursor)
      if (cursor && !exhausted) {
        try {
          await cursor.close()
        } catch {
          // Cleanup errors never replace the transfer result.
        }
      }
      if (client && !committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Cleanup errors never replace the transfer result.
        }
      }
      try {
        await client?.end()
      } catch {
        // Cleanup errors never replace the transfer result.
      }
      socket?.destroy()
    }
  }
}

function validateRequests(requests: TransferDataBatchRequest[]): void {
  if (requests.length === 0 || new Set(requests.map((batch) => batch.id)).size !== requests.length) {
    throw new TransferDataError('INVALID_TRANSFER_DATA')
  }
  for (const batch of requests) {
    if (!batch.id) throw new TransferDataError('INVALID_TRANSFER_DATA')
    validateRequest(batch.request)
  }
}

function validateRequest(request: TransferDataRequest): void {
  if (!Number.isSafeInteger(request.batchSize) || request.batchSize < 1 || request.batchSize > 10_000) {
    throw new TransferDataError('INVALID_TRANSFER_DATA')
  }
  if (request.table.columns.length === 0 || request.table.columns.some((column) => column.valueType === 'unsupported')) {
    throw new TransferDataError('INVALID_TRANSFER_DATA')
  }
}

function encodeRow(row: Record<string, unknown>, request: TransferDataRequest): TransferDataRow {
  const encoded: TransferDataRow = {}
  try {
    for (const column of request.table.columns) {
      if (!(column.name in row) || column.valueType === 'unsupported') {
        throw new TransferDataError('TRANSFER_DATA_FAILED')
      }
      encoded[column.name] = encodeDatabaseValue(normalizeDate(row[column.name], column.valueType), column.valueType)
    }
    return encoded
  } catch (error) {
    if (error instanceof TransferDataError) throw error
    throw new TransferDataError('TRANSFER_DATA_FAILED')
  }
}

function normalizeDate(value: unknown, type: string): unknown {
  if (!(value instanceof Date)) return value
  const iso = value.toISOString()
  if (type === 'date') return iso.slice(0, 10)
  if (type === 'datetime') return iso.slice(0, -1)
  if (type === 'timestamptz') return iso
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferDataError('TRANSFER_DATA_CANCELLED')
}
