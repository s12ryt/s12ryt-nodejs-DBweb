import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { MutationTable } from '../data/row-write-policy.js'
import type { ExactJsonImportRow, ExactJsonImportTablePlan } from './exact-json-import-service.js'
import {
  ExactJsonImportGatewayError,
  MysqlExactJsonImportGateway,
  type MysqlImportConnection,
} from './mysql-exact-json-import-gateway.js'
import {
  PostgresExactJsonImportGateway,
  type PostgresImportClient,
} from './postgres-exact-json-import-gateway.js'

const postgresConnection: ResolvedConnection = {
  id: 'connection-1', name: 'PostgreSQL', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const mysqlConnection: ResolvedConnection = {
  ...postgresConnection, name: 'MySQL', engine: 'mysql', port: 3306,
}
const table: MutationTable = {
  schema: 'public', name: 'members',
  columns: [
    { name: 'id', valueType: 'bigint', nullable: false, generated: true },
    { name: 'name', valueType: 'string', nullable: false, generated: false },
  ],
  uniqueKeys: [{ name: 'members_pkey', kind: 'primary', columns: ['id'] }],
}

describe('PostgresExactJsonImportGateway', () => {
  it('imports skip and update rows in one atomic transaction with parameterized values', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values
      if (sql.includes('ON CONFLICT DO NOTHING')) return { rows: [], rowCount: 0 }
      if (sql.includes('ON CONFLICT ("id")')) return { rows: [{ dbweb_inserted: false }], rowCount: 1 }
      return { rows: [], rowCount: null }
    })
    const client: PostgresImportClient = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresExactJsonImportGateway(() => client)

    const result = await gateway.execute(postgresConnection, {
      transaction: 'atomic', batchSize: 100,
      tables: [plan('skip'), plan('update', 'updates')],
      rows: rows([
        { sourceId: 'users', id: '1', name: "O'Reilly" },
        { sourceId: 'updates', id: '2', name: 'Changed' },
      ]),
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ processedRows: 2, insertedRows: 0, updatedRows: 1, skippedRows: 1, batches: 1 })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'INSERT INTO "public"."members" ("id", "name") VALUES ($1, $2) ON CONFLICT DO NOTHING',
      'INSERT INTO "public"."members" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name" RETURNING (xmax = 0) AS dbweb_inserted',
      expect.stringContaining('pg_get_serial_sequence'),
      'COMMIT',
    ])
    expect(query.mock.calls[1]?.[1]).toEqual([1n, "O'Reilly"])
  })

  it('rolls back every row in atomic mode when replacement fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw new Error('driver-secret')
      return { rows: [], rowCount: sql.startsWith('DELETE') ? 1 : null }
    })
    const client: PostgresImportClient = { connect: vi.fn(), query, end: vi.fn() }
    const gateway = new PostgresExactJsonImportGateway(() => client)

    await expect(gateway.execute(postgresConnection, {
      transaction: 'atomic', batchSize: 100, tables: [plan('replace')],
      rows: rows([{ sourceId: 'users', id: '1', name: 'One' }]),
      signal: new AbortController().signal,
    })).rejects.toEqual(new ExactJsonImportGatewayError('IMPORT_DATA_FAILED', {
      processedRows: 0, insertedRows: 0, updatedRows: 0, skippedRows: 0, batches: 0,
    }))
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', expect.stringMatching(/^DELETE /), expect.stringMatching(/^INSERT /), 'ROLLBACK'])
  })
})

describe('MysqlExactJsonImportGateway', () => {
  it('commits completed batches and reports partial progress when a later batch fails', async () => {
    let inserts = 0
    const query = vi.fn(async (sql: string): Promise<[unknown, unknown]> => {
      if (sql.startsWith('INSERT')) {
        inserts += 1
        if (inserts === 101) throw new Error('driver-secret')
        return [{ affectedRows: 1, insertId: inserts }, []]
      }
      return [[], []]
    })
    const client: MysqlImportConnection = {
      query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(),
    }
    const gateway = new MysqlExactJsonImportGateway(async () => client)
    const values = Array.from({ length: 101 }, (_, index) => ({
      sourceId: 'users', id: String(index + 1), name: `Member ${index + 1}`,
    }))

    await expect(gateway.execute(mysqlConnection, {
      transaction: 'batch', batchSize: 100, tables: [plan('skip')], rows: rows(values),
      signal: new AbortController().signal,
    })).rejects.toEqual(new ExactJsonImportGatewayError('IMPORT_DATA_FAILED', {
      processedRows: 100, insertedRows: 100, updatedRows: 0, skippedRows: 0, batches: 1,
    }))
    expect(client.beginTransaction).toHaveBeenCalledTimes(2)
    expect(client.commit).toHaveBeenCalledOnce()
    expect(client.rollback).toHaveBeenCalledOnce()
  })

  it('uses explicit delete plus insert for confirmed replacement', async () => {
    const query = vi.fn(async (sql: string): Promise<[unknown, unknown]> => [
      { affectedRows: sql.startsWith('DELETE') ? 1 : 1, insertId: 0 }, [],
    ])
    const client: MysqlImportConnection = {
      query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(),
    }
    const gateway = new MysqlExactJsonImportGateway(async () => client)

    const result = await gateway.execute(mysqlConnection, {
      transaction: 'atomic', batchSize: 100, tables: [plan('replace')],
      rows: rows([{ sourceId: 'users', id: '1', name: 'One' }]),
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ processedRows: 1, insertedRows: 1, updatedRows: 0, skippedRows: 0, batches: 1 })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'DELETE FROM `public`.`members` WHERE `id` = ?',
      'INSERT INTO `public`.`members` (`id`, `name`) VALUES (?, ?)',
    ])
  })

  it('reports only committed batches when cancellation interrupts the next batch', async () => {
    const controller = new AbortController()
    const query = vi.fn(async (): Promise<[unknown, unknown]> => [
      { affectedRows: 1, insertId: 0 }, [],
    ])
    const client: MysqlImportConnection = {
      query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(),
    }
    const gateway = new MysqlExactJsonImportGateway(async () => client)
    const source = (async function* (): AsyncIterable<ExactJsonImportRow> {
      for (let index = 1; index <= 101; index += 1) {
        if (index === 101) controller.abort()
        yield* rows([{ sourceId: 'users', id: String(index), name: `Member ${index}` }])
      }
    })()

    await expect(gateway.execute(mysqlConnection, {
      transaction: 'batch', batchSize: 100, tables: [plan('skip')], rows: source,
      signal: controller.signal,
    })).rejects.toEqual(new ExactJsonImportGatewayError('IMPORT_DATA_CANCELLED', {
      processedRows: 100, insertedRows: 100, updatedRows: 0, skippedRows: 0, batches: 1,
    }))
  })
})

function plan(
  conflict: 'skip' | 'update' | 'replace',
  sourceId = 'users',
): ExactJsonImportTablePlan {
  return {
    sourceId,
    source: { id: sourceId, schema: 'public', table: sourceId, columns: [] },
    target: table,
    mapping: { mapped: [], missing: [], ignored: [] },
    conflict: {
      conflict, transaction: 'batch', batchSize: 100,
      identity: table.uniqueKeys[0]!, preserveIdentity: true, resumed: false,
    },
  }
}

function rows(values: Array<{ sourceId: string; id: string; name: string }>): AsyncIterable<ExactJsonImportRow> {
  return (async function* () {
    for (const value of values) {
      yield {
        sourceId: value.sourceId,
        values: {
          id: { kind: 'value', type: 'bigint', value: value.id },
          name: { kind: 'value', type: 'string', value: value.name },
        },
      }
    }
  })()
}
