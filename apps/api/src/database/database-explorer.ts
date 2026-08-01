import type { ConnectionService } from '../connections/connection-service.js'
import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'
import {
  decodeKeysetCursor,
  type KeysetCursorValue,
  type KeysetDirection,
} from './keyset-pagination.js'

export interface DatabaseTable {
  schema: string
  name: string
  type: 'table' | 'view'
}

export interface DatabaseColumn {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  defaultValue?: string
}

export type RowPage = {
  columns: string[]
  rows: Array<Record<string, unknown>>
} & (
  | {
      paginationMode: 'keyset'
      nextCursor: string | null
      previousCursor: string | null
    }
  | {
      paginationMode: 'offset'
      nextOffset: number | null
      warning: 'OFFSET_PAGINATION'
    }
)

export type RowPagination =
  | {
      mode: 'keyset'
      key: string[]
      direction: KeysetDirection
      values?: KeysetCursorValue[]
    }
  | { mode: 'offset'; offset: number }

export interface DatabaseGateway {
  listSchemas(connection: ResolvedConnection): Promise<string[]>
  listTables(connection: ResolvedConnection, schema: string): Promise<DatabaseTable[]>
  describeTable(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<DatabaseColumn[]>
  findStableKey?(
    connection: ResolvedConnection,
    schema: string,
    table: string,
  ): Promise<string[] | undefined>
  readRows(
    connection: ResolvedConnection,
    page: { schema: string; table: string; limit: number; pagination: RowPagination },
  ): Promise<RowPage>
}

export class ExplorerError extends Error {
  constructor(readonly code: 'INVALID_PAGE') {
    super(code)
    this.name = 'ExplorerError'
  }
}

export class DatabaseExplorer {
  constructor(
    private readonly connections: ConnectionService,
    private readonly gateways: Record<DatabaseEngine, DatabaseGateway>,
  ) {}

  async listSchemas(connectionId: string): Promise<string[]> {
    const { connection, gateway } = await this.resolve(connectionId)
    return gateway.listSchemas(connection)
  }

  async listTables(connectionId: string, schema: string): Promise<DatabaseTable[]> {
    const { connection, gateway } = await this.resolve(connectionId)
    return gateway.listTables(connection, schema)
  }

  async describeTable(
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<DatabaseColumn[]> {
    const { connection, gateway } = await this.resolve(connectionId)
    return gateway.describeTable(connection, schema, table)
  }

  async readRows(
    connectionId: string,
    schema: string,
    table: string,
    page: { limit?: number; offset?: number; cursor?: string; direction?: KeysetDirection },
  ): Promise<RowPage> {
    const limit = page.limit ?? 100
    const offset = page.offset ?? 0
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw new ExplorerError('INVALID_PAGE')
    }
    const { connection, gateway } = await this.resolve(connectionId)
    const stableKey = await gateway.findStableKey?.(connection, schema, table)
    if (stableKey && stableKey.length > 0) {
      const cursor = page.cursor ? decodeKeysetCursor(page.cursor, stableKey) : undefined
      const direction = cursor?.direction ?? page.direction ?? 'forward'
      return gateway.readRows(connection, {
        schema,
        table,
        limit,
        pagination: {
          mode: 'keyset',
          key: stableKey,
          direction,
          ...(cursor ? { values: cursor.values } : {}),
        },
      })
    }
    if (page.cursor || page.direction) throw new ExplorerError('INVALID_PAGE')
    return gateway.readRows(connection, {
      schema,
      table,
      limit,
      pagination: { mode: 'offset', offset },
    })
  }

  private async resolve(connectionId: string) {
    const connection = await this.connections.resolveConnection(connectionId)
    return { connection, gateway: this.gateways[connection.engine] }
  }
}
