import { describe, expect, it, vi } from 'vitest'

import type { PostgresClientLike } from '../connections/postgres-connector.js'
import type { SqlDumpObject } from './sql-dump-manifest.js'
import { loadPostgresSqlDumpData } from './postgres-sql-restore-data-loader.js'
import { loadMysqlSqlDumpData } from './mysql-sql-restore-data-loader.js'

describe('SQL restore data loaders', () => {
  it('loads exact tagged rows through the active PostgreSQL session and synchronizes identity', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, ...(values ? { values } : {}) })
        if (sql.startsWith('SELECT pg_get_serial_sequence')) {
          return { rows: [{ dbweb_sequence: 'public.orders_id_seq' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    } as unknown as PostgresClientLike

    await loadPostgresSqlDumpData(
      client,
      tableObject('postgres'),
      'data/public.orders.ndjson',
      chunks(exactRows()),
      new AbortController().signal,
    )

    expect(calls[0]).toEqual({
      sql: 'INSERT INTO "public"."orders" ("id", "amount", "note") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      values: [9007199254740993n, '12.30', ''],
    })
    expect(calls[1]).toEqual({
      sql: 'INSERT INTO "public"."orders" ("id", "amount", "note") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      values: [9007199254740994n, '0.10', null],
    })
    expect(calls.at(-1)).toEqual({
      sql: 'SELECT setval($1::regclass, COALESCE(MAX("id"), 1), COUNT(*) > 0) FROM "public"."orders"',
      values: ['public.orders_id_seq'],
    })
  })

  it('loads exact rows through MySQL and explicitly advances AUTO_INCREMENT', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]): Promise<[unknown, unknown]> => {
        calls.push({ sql, ...(values ? { values } : {}) })
        if (sql.startsWith('SELECT COALESCE')) return [[{ dbweb_next: '9007199254740995' }], []]
        return [{ affectedRows: 1 }, []]
      }),
      end: vi.fn(),
    }

    await loadMysqlSqlDumpData(
      client,
      tableObject('mysql'),
      'data/app.orders.ndjson',
      chunks(exactRows('app')),
      new AbortController().signal,
    )

    expect(calls[0]?.sql).toContain('INSERT IGNORE INTO `app`.`orders`')
    expect(calls.at(-1)).toEqual({ sql: 'ALTER TABLE `app`.`orders` AUTO_INCREMENT = 9007199254740995' })
  })

  it('rejects package columns that do not match the immutable CREATE TABLE command', async () => {
    const client = { query: vi.fn() } as unknown as PostgresClientLike
    const invalid = exactRows().replace('"type":"decimal"', '"type":"string"')

    await expect(loadPostgresSqlDumpData(
      client,
      tableObject('postgres'),
      'data/public.orders.ndjson',
      chunks(invalid),
      new AbortController().signal,
    )).rejects.toThrow('RESTORE_CHANGED')
    expect(client.query).not.toHaveBeenCalled()
  })
})

function tableObject(engine: 'postgres' | 'mysql'): SqlDumpObject {
  const schema = engine === 'postgres' ? 'public' : 'app'
  return {
    id: `table:${schema}.orders`, kind: 'table', schema, name: 'orders', dependencies: [],
    createCommands: [{
      kind: 'create-table', schema, name: 'orders', primaryKey: ['id'],
      columns: [
        { name: 'id', type: { name: 'bigint' }, nullable: false, identity: true },
        { name: 'amount', type: { name: 'decimal', precision: 20, scale: 2 }, nullable: false },
        { name: 'note', type: { name: 'text' }, nullable: true },
      ],
    }],
    dropCommand: { kind: 'drop-table', schema, name: 'orders', confirmed: true },
    dataEntry: `data/${schema}.orders.ndjson`,
  }
}

function exactRows(schema = 'public'): string {
  return [
    JSON.stringify({
      kind: 'manifest', format: 'dbweb-exact-json', version: 1,
      tables: [{
        id: `table:${schema}.orders`, schema, table: 'orders',
        columns: [
          { name: 'id', type: 'bigint' }, { name: 'amount', type: 'decimal' }, { name: 'note', type: 'string' },
        ],
      }],
    }),
    JSON.stringify({
      kind: 'row', table: `table:${schema}.orders`, values: {
        id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
        amount: { kind: 'value', type: 'decimal', value: '12.30' },
        note: { kind: 'value', type: 'string', value: '' },
      },
    }),
    JSON.stringify({
      kind: 'row', table: `table:${schema}.orders`, values: {
        id: { kind: 'value', type: 'bigint', value: '9007199254740994' },
        amount: { kind: 'value', type: 'decimal', value: '0.10' },
        note: { kind: 'null' },
      },
    }),
    '',
  ].join('\n')
}

async function* chunks(value: string): AsyncIterable<Buffer> {
  for (let index = 0; index < value.length; index += 7) yield Buffer.from(value.slice(index, index + 7))
}
