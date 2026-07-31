import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { decodeExactJson } from './exact-json-format.js'
import { SqlDumpSnapshotCatalog } from './sql-dump-snapshot-catalog.js'
import {
  PostgresSqlDumpSnapshotSessionFactory,
  type PostgresSqlDumpClient,
  type PostgresSqlDumpCursor,
} from './postgres-sql-dump-snapshot.js'

const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}

describe('PostgreSQL SQL dump snapshot', () => {
  it('exports core table DDL and exact tagged rows from one read-only snapshot', async () => {
    const queries: string[] = []
    const cursor = new FakeCursor()
    const client: PostgresSqlDumpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((input: string | PostgresSqlDumpCursor) => {
        if (typeof input !== 'string') return input
        queries.push(input)
        if (input === 'SHOW server_version') return Promise.resolve({ rows: [{ server_version: '9.6.24' }] })
        if (input.includes('dbweb_table_schema')) return Promise.resolve({ rows: [{ dbweb_table_schema: 'public', dbweb_table_name: 'orders' }] })
        if (input.includes('dbweb_schema_name')) return Promise.resolve({ rows: [{ dbweb_schema_name: 'public' }] })
        if (input.includes('dbweb_column_name')) return Promise.resolve({ rows: [
          {
            dbweb_column_name: 'id', dbweb_type_name: 'int8', dbweb_type_category: 'N',
            dbweb_formatted_type: 'bigint', dbweb_nullable: false,
            dbweb_default_expression: `nextval('public.orders_id_seq'::regclass)`, dbweb_identity: '',
          },
          {
            dbweb_column_name: 'code', dbweb_type_name: 'varchar', dbweb_type_category: 'S',
            dbweb_formatted_type: 'character varying(32)', dbweb_nullable: false,
            dbweb_default_expression: null, dbweb_identity: '',
          },
        ] })
        if (input.includes('dbweb_constraint_type')) return Promise.resolve({ rows: [
          { dbweb_constraint_name: 'orders_pkey', dbweb_constraint_type: 'p', dbweb_columns: '{id}' },
          { dbweb_constraint_name: 'orders_code_key', dbweb_constraint_type: 'u', dbweb_columns: '{code}' },
          { dbweb_constraint_name: 'orders_code_check', dbweb_constraint_type: 'c', dbweb_columns: '{}', dbweb_check_expression: 'char_length(code) > 0' },
        ] })
        if (input.includes('dbweb_sequence_schema') && !input.includes('dbweb_sequence_start')) return Promise.resolve({ rows: [{
          dbweb_sequence_schema: 'public', dbweb_sequence_name: 'orders_id_seq',
        }] })
        if (input.includes('dbweb_sequence_start')) return Promise.resolve({ rows: [{
          dbweb_sequence_schema: 'public', dbweb_sequence_name: 'orders_id_seq',
          dbweb_sequence_start: '1', dbweb_sequence_increment: '1', dbweb_sequence_min: '1',
          dbweb_sequence_max: '9223372036854775807', dbweb_sequence_cache: '1', dbweb_sequence_cycle: false,
        }] })
        if (input.includes('dbweb_index_method')) return Promise.resolve({ rows: [{
          dbweb_index_name: 'orders_code_idx', dbweb_index_method: 'btree', dbweb_unique: false,
          dbweb_targets: '{code}', dbweb_orders: '{asc}', dbweb_predicate: null,
        }] })
        return Promise.resolve({ rows: [] })
      }) as PostgresSqlDumpClient['query'],
      end: vi.fn().mockResolvedValue(undefined),
    }
    const factory = new PostgresSqlDumpSnapshotSessionFactory(
      vi.fn(() => client),
      vi.fn((sql, values) => cursor.configure(sql, values)),
    )
    const catalog = new SqlDumpSnapshotCatalog(factory)

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'gzip', scope: { kind: 'table', schema: 'public', table: 'orders' }, includeData: true,
    }, new AbortController().signal, async (value) => {
      const decoded = await decodeExactJson(value.entries[0]!.content)
      const records = []
      for await (const record of decoded.records) records.push(record)
      return { value, decoded, records }
    })

    expect(snapshot.value.manifest.objects.map((object) => object.id)).toEqual([
      'sequence:public.orders_id_seq', 'table:public.orders', 'constraint:public.orders.orders_code_key',
      'constraint:public.orders.orders_code_check', 'index:public.orders.orders_code_idx',
    ])
    expect(snapshot.value.manifest.objects.find((object) => object.id === 'table:public.orders')?.dependencies)
      .toEqual(['sequence:public.orders_id_seq'])
    expect(snapshot.value.manifest.objects.find((object) => object.id === 'table:public.orders')?.createCommands[0])
      .toEqual(expect.objectContaining({
      kind: 'create-table', primaryKey: ['id'], columns: [
        expect.objectContaining({
          name: 'id', type: { name: 'bigint' },
          default: { kind: 'sequence', schema: 'public', name: 'orders_id_seq' },
        }),
        expect.objectContaining({ name: 'code', type: { name: 'varchar', length: 32 } }),
      ],
      }))
    expect(snapshot.records).toEqual([{ kind: 'row', table: 'table:public.orders', values: {
      id: { kind: 'value', type: 'bigint', value: '1' },
      code: { kind: 'value', type: 'string', value: '' },
    } }])
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(queries.at(-1)).toBe('COMMIT')
    expect(queries.some((sql) => sql.includes('FROM pg_catalog.pg_sequence'))).toBe(false)
    expect(cursor.sql).toContain('SELECT "id", "code" FROM "public"."orders"')
  })

  it('preserves PostgreSQL identity columns on supported server versions', async () => {
    const client: PostgresSqlDumpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((input: string | PostgresSqlDumpCursor) => {
        if (typeof input !== 'string') return input
        if (input === 'SHOW server_version') return Promise.resolve({ rows: [{ server_version: '17.5' }] })
        if (input.includes('dbweb_table_schema')) return Promise.resolve({ rows: [{ dbweb_table_schema: 'public', dbweb_table_name: 'events' }] })
        if (input.includes('dbweb_column_name')) return Promise.resolve({ rows: [{
          dbweb_column_name: 'id', dbweb_type_name: 'int8', dbweb_type_category: 'N',
          dbweb_formatted_type: 'bigint', dbweb_nullable: false,
          dbweb_default_expression: null, dbweb_identity: 'd',
        }] })
        if (input.includes('dbweb_constraint_type')) return Promise.resolve({ rows: [{
          dbweb_constraint_name: 'events_pkey', dbweb_constraint_type: 'p', dbweb_columns: '{id}',
        }] })
        return Promise.resolve({ rows: [] })
      }) as PostgresSqlDumpClient['query'],
      end: vi.fn().mockResolvedValue(undefined),
    }
    const catalog = new SqlDumpSnapshotCatalog(new PostgresSqlDumpSnapshotSessionFactory(
      vi.fn(() => client),
      vi.fn(() => new FakeCursor()),
    ))

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'none', scope: { kind: 'table', schema: 'public', table: 'events' }, includeData: false,
    }, new AbortController().signal, async (value) => value)

    expect(snapshot.manifest.objects[0]?.createCommands[0]).toEqual(expect.objectContaining({
      kind: 'create-table',
      columns: [expect.objectContaining({ name: 'id', identity: true })],
    }))
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('a.attidentity::text'), ['public', 'events'])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FROM pg_catalog.pg_sequence'), ['public', 'events'])
  })

  it('exports structured PostgreSQL views, sequences, types, domains, and extensions with dependencies', async () => {
    const queries: string[] = []
    const client: PostgresSqlDumpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((input: string | PostgresSqlDumpCursor) => {
        if (typeof input !== 'string') return input
        queries.push(input)
        if (input === 'SHOW server_version') return Promise.resolve({ rows: [{ server_version: '17.5' }] })
        if (input.includes('dbweb_schema_name')) return Promise.resolve({ rows: [{ dbweb_schema_name: 'public' }] })
        if (input.includes('dbweb_table_schema')) return Promise.resolve({ rows: [{
          dbweb_table_schema: 'public', dbweb_table_name: 'orders', dbweb_partition_key: 'RANGE (id)',
        }] })
        if (input.includes('dbweb_column_name')) return Promise.resolve({ rows: [{
          dbweb_column_name: 'id', dbweb_type_name: 'int8', dbweb_type_category: 'N',
          dbweb_formatted_type: 'bigint', dbweb_nullable: false,
          dbweb_default_expression: `nextval('public.orders_id_seq'::regclass)`, dbweb_identity: '',
        }] })
        if (input.includes('dbweb_constraint_type')) return Promise.resolve({ rows: [{
          dbweb_constraint_name: 'orders_pkey', dbweb_constraint_type: 'p', dbweb_columns: '{id}',
        }] })
        if (input.includes('dbweb_view_kind')) return Promise.resolve({ rows: [
          {
            dbweb_view_schema: 'public', dbweb_view_name: 'active_orders', dbweb_view_kind: 'v',
            dbweb_view_definition: ' SELECT orders.id\n   FROM orders;',
            dbweb_dependencies: '{table:public.orders}',
          },
          {
            dbweb_view_schema: 'public', dbweb_view_name: 'order_totals', dbweb_view_kind: 'm',
            dbweb_view_definition: ' SELECT count(*) AS total\n   FROM orders;',
            dbweb_dependencies: '{table:public.orders}', dbweb_populated: false,
          },
        ] })
        if (input.includes('dbweb_sequence_start')) return Promise.resolve({ rows: [{
          dbweb_sequence_schema: 'public', dbweb_sequence_name: 'orders_id_seq',
          dbweb_sequence_start: '1', dbweb_sequence_increment: '1', dbweb_sequence_min: '1',
          dbweb_sequence_max: '9223372036854775807', dbweb_sequence_cache: '1', dbweb_sequence_cycle: false,
        }] })
        if (input.includes('dbweb_type_kind')) return Promise.resolve({ rows: [
          {
            dbweb_type_schema: 'public', dbweb_type_name: 'order_state', dbweb_type_kind: 'e',
            dbweb_enum_values: '{new,done}',
          },
          {
            dbweb_type_schema: 'public', dbweb_type_name: 'positive_amount', dbweb_type_kind: 'd',
            dbweb_base_type: 'numeric(12,2)', dbweb_nullable: false,
            dbweb_default_expression: '0', dbweb_check_expression: 'VALUE >= 0',
          },
        ] })
        if (input.includes('dbweb_extension_name')) return Promise.resolve({ rows: [{
          dbweb_extension_name: 'pgcrypto', dbweb_extension_schema: 'public', dbweb_extension_version: '1.3',
        }] })
        if (input.includes('dbweb_routine_kind')) return Promise.resolve({ rows: [
          {
            dbweb_routine_schema: 'public', dbweb_routine_name: 'order_total', dbweb_routine_kind: 'f',
            dbweb_arguments: [], dbweb_return_type: 'numeric', dbweb_returns_set: false,
            dbweb_language: 'sql', dbweb_body: 'SELECT 42::numeric', dbweb_volatility: 's',
            dbweb_security_definer: false, dbweb_strict: true,
          },
          {
            dbweb_routine_schema: 'public', dbweb_routine_name: 'refresh_orders', dbweb_routine_kind: 'p',
            dbweb_arguments: [], dbweb_return_type: null, dbweb_returns_set: false,
            dbweb_language: 'plpgsql', dbweb_body: 'BEGIN NULL; END', dbweb_volatility: 'v',
            dbweb_security_definer: true, dbweb_strict: false,
          },
        ] })
        if (input.includes('dbweb_trigger_name')) return Promise.resolve({ rows: [{
          dbweb_trigger_schema: 'public', dbweb_trigger_table: 'orders', dbweb_trigger_name: 'orders_audit',
          dbweb_trigger_timing: 'after', dbweb_trigger_events: '{insert,update}', dbweb_for_each: 'row',
          dbweb_when: 'NEW.id IS NOT NULL', dbweb_function_schema: 'public', dbweb_function_name: 'order_total',
          dbweb_function_arguments: '{}',
        }] })
        if (input.includes('dbweb_partition_name')) return Promise.resolve({ rows: [{
          dbweb_partition_schema: 'public', dbweb_parent_table: 'orders',
          dbweb_partition_name: 'orders_2026', dbweb_partition_definition: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        }] })
        return Promise.resolve({ rows: [] })
      }) as PostgresSqlDumpClient['query'],
      end: vi.fn().mockResolvedValue(undefined),
    }
    const catalog = new SqlDumpSnapshotCatalog(new PostgresSqlDumpSnapshotSessionFactory(
      vi.fn(() => client),
      vi.fn(() => new FakeCursor()),
    ))

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'none', scope: { kind: 'schema', schema: 'public' }, includeData: false,
    }, new AbortController().signal, async (value) => value)

    expect(snapshot.manifest.objects.map((object) => object.id)).toEqual([
      'schema:public',
      'sequence:public.orders_id_seq',
      'type:public.order_state',
      'domain:public.positive_amount',
      'table:public.orders',
      'view:public.active_orders',
      'materialized-view:public.order_totals',
      'extension:pgcrypto',
      'function:public.order_total',
      'procedure:public.refresh_orders',
      'trigger:public.orders.orders_audit',
      'partition:public.orders.orders_2026',
    ])
    expect(snapshot.manifest.objects.find((object) => object.id === 'table:public.orders')?.dependencies)
      .toEqual(['schema:public', 'sequence:public.orders_id_seq'])
    expect(snapshot.manifest.objects.find((object) => object.id === 'table:public.orders')?.createCommands[0])
      .toEqual(expect.objectContaining({ partitionBy: { method: 'range', expression: 'id' } }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'view:public.active_orders')).toEqual(expect.objectContaining({
      dependencies: ['schema:public', 'table:public.orders'],
      createCommands: [expect.objectContaining({
        kind: 'create-view', schema: 'public', name: 'active_orders',
        query: 'SELECT orders.id\n   FROM orders;', confirmed: true,
      })],
    }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'materialized-view:public.order_totals'))
      .toEqual(expect.objectContaining({
        createCommands: [expect.objectContaining({ kind: 'create-materialized-view', withData: false, confirmed: true })],
      }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'sequence:public.orders_id_seq')?.createCommands[0])
      .toEqual(expect.objectContaining({ kind: 'create-sequence', start: 1, increment: 1, minValue: 1, cache: 1 }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'type:public.order_state')?.createCommands[0])
      .toEqual({ kind: 'create-enum', schema: 'public', name: 'order_state', values: ['new', 'done'] })
    expect(snapshot.manifest.objects.find((object) => object.id === 'domain:public.positive_amount')?.createCommands[0])
      .toEqual(expect.objectContaining({
        kind: 'create-domain', baseType: { name: 'numeric', precision: 12, scale: 2 },
        nullable: false, default: { kind: 'literal', value: 0 }, check: 'VALUE >= 0', confirmed: true,
      }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'extension:pgcrypto')?.createCommands[0])
      .toEqual({ kind: 'create-extension', name: 'pgcrypto', schema: 'public', version: '1.3', confirmed: true })
    expect(snapshot.manifest.objects.find((object) => object.id === 'function:public.order_total')).toEqual(expect.objectContaining({
      dependencies: ['schema:public'],
      createCommands: [expect.objectContaining({
        kind: 'create-routine', routineKind: 'function', schema: 'public', name: 'order_total',
        arguments: [], returns: { name: 'numeric' }, language: 'sql', body: 'SELECT 42::numeric',
        volatility: 'stable', strict: true, confirmed: true,
      })],
    }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'procedure:public.refresh_orders')?.createCommands[0])
      .toEqual(expect.objectContaining({
        kind: 'create-routine', routineKind: 'procedure', language: 'plpgsql',
        security: 'definer', body: 'BEGIN NULL; END', confirmed: true,
      }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'trigger:public.orders.orders_audit')).toEqual(expect.objectContaining({
      dependencies: ['schema:public', 'table:public.orders', 'function:public.order_total'],
      createCommands: [expect.objectContaining({
        kind: 'create-trigger', table: 'orders', name: 'orders_audit', timing: 'after',
        events: ['insert', 'update'], forEach: 'row', functionName: 'order_total', confirmed: true,
      })],
    }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'partition:public.orders.orders_2026')).toEqual(expect.objectContaining({
      dependencies: ['schema:public', 'table:public.orders'],
      createCommands: [{
        kind: 'create-partition', schema: 'public', table: 'orders', name: 'orders_2026',
        definition: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')", confirmed: true,
      }],
    }))
    expect(queries.find((sql) => sql.includes('dbweb_routine_kind'))).toContain("dep.deptype = 'e'")
    expect(queries.find((sql) => sql.includes('dbweb_table_schema'))).toContain('pg_get_partkeydef')
  })
})

class FakeCursor implements PostgresSqlDumpCursor {
  sql = ''
  values: unknown[] = []
  private reads = 0

  configure(sql: string, values: unknown[]) {
    this.sql = sql
    this.values = values
    return this
  }

  async read() {
    this.reads += 1
    return this.reads === 1 ? [{ id: '1', code: '' }] : []
  }

  async close() {}
}
