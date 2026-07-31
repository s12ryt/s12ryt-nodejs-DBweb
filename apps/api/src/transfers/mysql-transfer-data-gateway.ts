import type { Duplex, Readable } from 'node:stream'

import mysql, { type ConnectionOptions } from 'mysql2'

import type { DatabaseSocketProvider } from '../connections/database-socket-provider.js'
import { mysqlClientOptions, type MysqlClientOptions } from '../connections/mysql-connector.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import { quoteMysqlIdentifier } from '../data/mutation-sql.js'
import { encodeDatabaseValue } from '../data/tagged-value.js'
import {
  TransferDataError,
  type TransferDataGateway,
  type TransferDataBatchRequest,
  type TransferDataBatchRow,
  type TransferDataRequest,
  type TransferDataRow,
} from './transfer-data-gateway.js'
import { buildMysqlTransferFilter } from './transfer-filter.js'

interface MysqlStreamingQuery {
  stream(options: { objectMode: true; highWaterMark: number }): Readable
}

export interface MysqlTransferConnection {
  query(
    sql: string,
    values: unknown[] | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): unknown
  end(callback: (error?: Error) => void): void
  destroy(): void
}

export type MysqlTransferConnectionFactory = (
  options: MysqlClientOptions & {
    supportBigNumbers: true
    bigNumberStrings: true
    dateStrings: true
  },
) => Promise<MysqlTransferConnection>

export type MysqlRowStreamFactory = (
  connection: MysqlTransferConnection,
  sql: string,
  values: unknown[],
  highWaterMark: number,
) => Readable

export class MysqlTransferDataGateway implements TransferDataGateway {
  constructor(
    private readonly createConnection: MysqlTransferConnectionFactory = connectMysql,
    private readonly createRowStream: MysqlRowStreamFactory = (connection, sql, values, highWaterMark) =>
      (connection.query(sql, values) as MysqlStreamingQuery).stream({ objectMode: true, highWaterMark }),
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
    let client: MysqlTransferConnection | undefined
    let rowStream: Readable | undefined
    let socket: Duplex | undefined
    let committed = false
    let currentSignal: AbortSignal | undefined
    const abortStream = () => rowStream?.destroy(new TransferDataError('TRANSFER_DATA_CANCELLED'))

    try {
      socket = await this.socketProvider?.open(connection)
      client = await this.createConnection({
        ...mysqlClientOptions(connection, socket),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      })
      await query(client, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await query(client, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')

      for (const batch of requests) {
        const request = batch.request
        throwIfAborted(request.signal)
        const filter = buildMysqlTransferFilter(request.table, request.filters)
        const columns = request.table.columns.map((column) => quoteMysqlIdentifier(column.name))
        const sql = `SELECT ${columns.join(', ')} FROM ${quoteMysqlIdentifier(request.table.schema)}.${quoteMysqlIdentifier(request.table.name)}${filter.sql ? ` WHERE ${filter.sql}` : ''}`
        rowStream = this.createRowStream(client, sql, filter.values, request.batchSize)
        currentSignal = request.signal
        currentSignal?.addEventListener('abort', abortStream, { once: true })

        for await (const rawRow of rowStream) {
          throwIfAborted(request.signal)
          if (!rawRow || typeof rawRow !== 'object') throw new TransferDataError('TRANSFER_DATA_FAILED')
          yield { id: batch.id, row: encodeRow(rawRow as Record<string, unknown>, request) }
        }
        currentSignal?.removeEventListener('abort', abortStream)
        currentSignal = undefined
        rowStream = undefined
      }

      await query(client, 'COMMIT')
      committed = true
    } catch (error) {
      if (error instanceof TransferDataError) throw error
      throw new TransferDataError('TRANSFER_DATA_FAILED')
    } finally {
      currentSignal?.removeEventListener('abort', abortStream)
      rowStream?.destroy()
      if (client && !committed) {
        try {
          await query(client, 'ROLLBACK')
        } catch {
          // Cleanup errors never replace the transfer result.
        }
      }
      try {
        await end(client)
      } catch {
        client?.destroy()
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

async function connectMysql(options: Parameters<MysqlTransferConnectionFactory>[0]): Promise<MysqlTransferConnection> {
  const connection = mysql.createConnection(options as ConnectionOptions) as unknown as MysqlTransferConnection & {
    connect(callback: (error?: Error) => void): void
  }
  await new Promise<void>((resolve, reject) => {
    connection.connect((error) => error ? reject(error) : resolve())
  })
  return connection
}

function query(connection: MysqlTransferConnection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error) => error ? reject(error) : resolve())
  })
}

function end(connection?: MysqlTransferConnection): Promise<void> {
  if (!connection) return Promise.resolve()
  return new Promise((resolve, reject) => {
    connection.end((error) => error ? reject(error) : resolve())
  })
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
      encoded[column.name] = encodeDatabaseValue(row[column.name], column.valueType)
    }
    return encoded
  } catch (error) {
    if (error instanceof TransferDataError) throw error
    throw new TransferDataError('TRANSFER_DATA_FAILED')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferDataError('TRANSFER_DATA_CANCELLED')
}
