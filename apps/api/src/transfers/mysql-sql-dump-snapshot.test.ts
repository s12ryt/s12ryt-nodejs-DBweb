// @vitest-environment node
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { decodeExactJson } from './exact-json-format.js'
import {
  MysqlSqlDumpSnapshotSessionFactory,
  type MysqlSqlDumpConnection,
} from './mysql-sql-dump-snapshot.js'
import { SqlDumpSnapshotCatalog } from './sql-dump-snapshot-catalog.js'

const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'mysql', host: 'db', port: 3306,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}

describe('MySQL SQL dump snapshot', () => {
  it('exports core table DDL and exact tagged rows from one consistent snapshot', async () => {
    const queries: string[] = []
    const client: MysqlSqlDumpConnection = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error, rows?: unknown) => void), callback?: (error?: Error, rows?: unknown) => void) => {
        queries.push(sql)
        const done = typeof values === 'function' ? values : callback
        if (!done) return undefined
        if (sql === 'SELECT VERSION() AS dbweb_version') done(undefined, [{ dbweb_version: '5.6.51' }])
        else if (sql.includes('dbweb_table_schema')) done(undefined, [{
          dbweb_table_schema: 'app', dbweb_table_name: 'orders', dbweb_engine: 'InnoDB',
          dbweb_collation: 'utf8mb4_unicode_ci', dbweb_charset: 'utf8mb4',
        }])
        else if (sql.includes('dbweb_index_name')) done(undefined, [
          { dbweb_index_name: 'PRIMARY', dbweb_non_unique: 0, dbweb_method: 'BTREE', dbweb_column_name: 'id', dbweb_sequence: 1, dbweb_prefix_length: null, dbweb_collation: 'A' },
          { dbweb_index_name: 'orders_code_key', dbweb_non_unique: 0, dbweb_method: 'BTREE', dbweb_column_name: 'code', dbweb_sequence: 1, dbweb_prefix_length: null, dbweb_collation: 'A' },
          { dbweb_index_name: 'orders_code_idx', dbweb_non_unique: 1, dbweb_method: 'BTREE', dbweb_column_name: 'code', dbweb_sequence: 1, dbweb_prefix_length: null, dbweb_collation: 'A' },
        ])
        else if (sql.includes('dbweb_constraint_type')) done(undefined, [{
          dbweb_constraint_name: 'orders_customer_fk', dbweb_constraint_type: 'FOREIGN KEY',
          dbweb_columns: 'parent_id', dbweb_reference_schema: 'app',
          dbweb_reference_table: 'orders', dbweb_reference_columns: 'id',
          dbweb_update_rule: 'CASCADE', dbweb_delete_rule: 'RESTRICT',
        }])
        else if (sql.includes('dbweb_data_type')) done(undefined, [
          { dbweb_column_name: 'id', dbweb_data_type: 'bigint', dbweb_column_type: 'bigint(20)', dbweb_nullable: 'NO', dbweb_default: null, dbweb_extra: 'auto_increment' },
          { dbweb_column_name: 'code', dbweb_data_type: 'varchar', dbweb_column_type: 'varchar(32)', dbweb_nullable: 'NO', dbweb_default: null, dbweb_extra: '' },
          { dbweb_column_name: 'parent_id', dbweb_data_type: 'bigint', dbweb_column_type: 'bigint(20)', dbweb_nullable: 'YES', dbweb_default: null, dbweb_extra: '' },
        ])
        else done(undefined, [])
        return undefined
      }),
      end: vi.fn((callback) => callback()),
      destroy: vi.fn(),
    }
    const factory = new MysqlSqlDumpSnapshotSessionFactory(
      vi.fn().mockResolvedValue(client),
      vi.fn(() => Readable.from([{ id: '1', code: '', parent_id: null }], { objectMode: true })),
    )
    const catalog = new SqlDumpSnapshotCatalog(factory)

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'gzip', scope: { kind: 'table', schema: 'app', table: 'orders' }, includeData: true,
    }, new AbortController().signal, async (value) => {
      const decoded = await decodeExactJson(value.entries[0]!.content)
      const records = []
      for await (const record of decoded.records) records.push(record)
      return { value, records }
    })

    expect(snapshot.value.manifest.objects.map((object) => object.id)).toEqual([
      'table:app.orders', 'constraint:app.orders.orders_code_key',
      'constraint:app.orders.orders_customer_fk', 'index:app.orders.orders_code_idx',
    ])
    expect(snapshot.value.manifest.objects[0]?.createCommands[0]).toEqual(expect.objectContaining({
      kind: 'create-table', engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci',
      primaryKey: ['id'], columns: [
        expect.objectContaining({ name: 'id', type: { name: 'bigint' }, identity: true }),
        expect.objectContaining({ name: 'code', type: { name: 'varchar', length: 32 } }),
        expect.objectContaining({ name: 'parent_id', type: { name: 'bigint' }, nullable: true }),
      ],
    }))
    expect(snapshot.records).toEqual([{ kind: 'row', table: 'table:app.orders', values: {
      id: { kind: 'value', type: 'bigint', value: '1' },
      code: { kind: 'value', type: 'string', value: '' },
      parent_id: { kind: 'null' },
    } }])
    expect(queries.slice(0, 2)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
    ])
    expect(queries.at(-1)).toBe('COMMIT')
  })

  it('exports enforced MySQL checks on supported server versions', async () => {
    const client: MysqlSqlDumpConnection = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error, rows?: unknown) => void), callback?: (error?: Error, rows?: unknown) => void) => {
        const done = typeof values === 'function' ? values : callback
        if (!done) return undefined
        if (sql === 'SELECT VERSION() AS dbweb_version') done(undefined, [{ dbweb_version: '8.4.0' }])
        else if (sql.includes('dbweb_table_schema')) done(undefined, [{
          dbweb_table_schema: 'app', dbweb_table_name: 'orders', dbweb_engine: 'InnoDB',
          dbweb_collation: 'utf8mb4_0900_ai_ci', dbweb_charset: 'utf8mb4',
        }])
        else if (sql.includes('dbweb_data_type')) done(undefined, [{
          dbweb_column_name: 'amount', dbweb_data_type: 'int', dbweb_column_type: 'int',
          dbweb_nullable: 'NO', dbweb_default: null, dbweb_extra: '',
        }])
        else if (sql.includes('dbweb_constraint_type')) done(undefined, [])
        else if (sql.includes('dbweb_check_expression')) done(undefined, [{
          dbweb_constraint_name: 'orders_amount_check', dbweb_check_expression: '`amount` > 0',
        }])
        else done(undefined, [])
        return undefined
      }),
      end: vi.fn((callback) => callback()),
      destroy: vi.fn(),
    }
    const catalog = new SqlDumpSnapshotCatalog(new MysqlSqlDumpSnapshotSessionFactory(
      vi.fn().mockResolvedValue(client),
      vi.fn(() => Readable.from([], { objectMode: true })),
    ))

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'none', scope: { kind: 'table', schema: 'app', table: 'orders' }, includeData: false,
    }, new AbortController().signal, async (value) => value)

    expect(snapshot.manifest.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'table:app.orders',
        createCommands: [expect.objectContaining({
          kind: 'create-table',
          columns: [expect.objectContaining({ name: 'amount', type: { name: 'int' } })],
        })],
      }),
      expect.objectContaining({
        id: 'constraint:app.orders.orders_amount_check',
        createCommands: [expect.objectContaining({
          kind: 'add-constraint',
          constraint: { kind: 'check', expression: '`amount` > 0' },
        })],
      }),
    ]))
  })

  it('uses conservative view dependencies on MySQL 5.6 without VIEW_TABLE_USAGE', async () => {
    const queries: string[] = []
    const client: MysqlSqlDumpConnection = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error, rows?: unknown) => void), callback?: (error?: Error, rows?: unknown) => void) => {
        queries.push(sql)
        const done = typeof values === 'function' ? values : callback
        if (!done) return undefined
        if (sql === 'SELECT VERSION() AS dbweb_version') done(undefined, [{ dbweb_version: '5.6.51' }])
        else if (sql.includes('dbweb_table_schema')) done(undefined, [{
          dbweb_table_schema: 'app', dbweb_table_name: 'orders', dbweb_engine: 'InnoDB',
          dbweb_collation: 'utf8mb4_unicode_ci', dbweb_charset: 'utf8mb4',
        }])
        else if (sql.includes('dbweb_data_type')) done(undefined, [{
          dbweb_column_name: 'id', dbweb_data_type: 'bigint', dbweb_column_type: 'bigint',
          dbweb_nullable: 'NO', dbweb_default: null, dbweb_extra: '',
        }])
        else if (sql.includes('dbweb_view_name')) done(undefined, [{
          dbweb_view_schema: 'app', dbweb_view_name: 'active_orders',
          dbweb_view_definition: 'select `orders`.`id` AS `id` from `orders`',
          dbweb_dependencies: null,
        }])
        else done(undefined, [])
        return undefined
      }),
      end: vi.fn((callback) => callback()),
      destroy: vi.fn(),
    }
    const catalog = new SqlDumpSnapshotCatalog(new MysqlSqlDumpSnapshotSessionFactory(
      vi.fn().mockResolvedValue(client),
      vi.fn(() => Readable.from([], { objectMode: true })),
    ))

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'none', scope: { kind: 'database' }, includeData: false,
    }, new AbortController().signal, async (value) => value)

    expect(queries.some((sql) => /view_table_usage/i.test(sql))).toBe(false)
    expect(snapshot.manifest.objects.find((object) => object.id === 'view:app.active_orders')?.dependencies)
      .toEqual(['table:app.orders'])
  })

  it('exports structured MySQL views, routines, triggers, events, and partitions', async () => {
    const client: MysqlSqlDumpConnection = {
      query: vi.fn((sql: string, values: unknown[] | ((error?: Error, rows?: unknown) => void), callback?: (error?: Error, rows?: unknown) => void) => {
        const done = typeof values === 'function' ? values : callback
        if (!done) return undefined
        if (sql === 'SELECT VERSION() AS dbweb_version') done(undefined, [{ dbweb_version: '8.4.0' }])
        else if (sql.includes('dbweb_table_schema')) done(undefined, [{
          dbweb_table_schema: 'app', dbweb_table_name: 'orders', dbweb_engine: 'InnoDB',
          dbweb_collation: 'utf8mb4_0900_ai_ci', dbweb_charset: 'utf8mb4',
        }])
        else if (sql.includes('dbweb_data_type')) done(undefined, [{
          dbweb_column_name: 'id', dbweb_data_type: 'bigint', dbweb_column_type: 'bigint',
          dbweb_nullable: 'NO', dbweb_default: null, dbweb_extra: '',
        }])
        else if (sql.includes('dbweb_view_name')) done(undefined, [{
          dbweb_view_schema: 'app', dbweb_view_name: 'active_orders',
          dbweb_view_definition: 'select `orders`.`id` AS `id` from `orders`',
          dbweb_dependencies: 'table:app.orders',
        }])
        else if (sql.includes('dbweb_routine_type')) done(undefined, [
          {
            dbweb_routine_schema: 'app', dbweb_routine_name: 'constant_value', dbweb_routine_type: 'FUNCTION',
            dbweb_return_type: 'int', dbweb_body: 'RETURN 7', dbweb_deterministic: 'YES',
            dbweb_data_access: 'NO SQL', dbweb_security: 'INVOKER',
          },
          {
            dbweb_routine_schema: 'app', dbweb_routine_name: 'refresh_orders', dbweb_routine_type: 'PROCEDURE',
            dbweb_return_type: null, dbweb_body: 'BEGIN SELECT 1; END', dbweb_deterministic: 'NO',
            dbweb_data_access: 'CONTAINS SQL', dbweb_security: 'DEFINER',
          },
        ])
        else if (sql.includes('dbweb_parameter_mode')) done(undefined, [])
        else if (sql.includes('dbweb_trigger_name')) done(undefined, [{
          dbweb_trigger_schema: 'app', dbweb_trigger_table: 'orders', dbweb_trigger_name: 'orders_audit',
          dbweb_trigger_timing: 'AFTER', dbweb_trigger_event: 'INSERT',
          dbweb_trigger_body: 'SET @last_order = NEW.id',
        }])
        else if (sql.includes('dbweb_event_name')) done(undefined, [{
          dbweb_event_schema: 'app', dbweb_event_name: 'purge_orders',
          dbweb_event_body: 'DELETE FROM orders WHERE id < 0', dbweb_execute_at: null,
          dbweb_interval_value: '1', dbweb_interval_field: 'DAY',
          dbweb_on_completion: 'PRESERVE', dbweb_status: 'ENABLED',
        }])
        else if (sql.includes('dbweb_partition_name')) done(undefined, [
          {
            dbweb_partition_schema: 'app', dbweb_partition_table: 'orders',
            dbweb_partition_name: 'p2026', dbweb_partition_method: 'RANGE',
            dbweb_partition_expression: 'id', dbweb_partition_description: '1000',
          },
          {
            dbweb_partition_schema: 'app', dbweb_partition_table: 'orders',
            dbweb_partition_name: 'pmax', dbweb_partition_method: 'RANGE',
            dbweb_partition_expression: 'id', dbweb_partition_description: 'MAXVALUE',
          },
        ])
        else done(undefined, [])
        return undefined
      }),
      end: vi.fn((callback) => callback()),
      destroy: vi.fn(),
    }
    const catalog = new SqlDumpSnapshotCatalog(new MysqlSqlDumpSnapshotSessionFactory(
      vi.fn().mockResolvedValue(client),
      vi.fn(() => Readable.from([], { objectMode: true })),
    ))

    const snapshot = await catalog.withSnapshot(connection, {
      compression: 'none', scope: { kind: 'database' }, includeData: false,
    }, new AbortController().signal, async (value) => value)

    expect(snapshot.manifest.objects.map((object) => object.id)).toEqual([
      'table:app.orders',
      'view:app.active_orders',
      'function:app.constant_value',
      'procedure:app.refresh_orders',
      'trigger:app.orders.orders_audit',
      'event:app.purge_orders',
      'partition:app.orders.p2026',
      'partition:app.orders.pmax',
    ])
    expect(snapshot.manifest.objects.find((object) => object.id === 'view:app.active_orders')).toEqual(expect.objectContaining({
      dependencies: ['table:app.orders'],
      createCommands: [expect.objectContaining({ kind: 'create-view', query: 'select `orders`.`id` AS `id` from `orders`' })],
    }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'function:app.constant_value')?.createCommands[0])
      .toEqual(expect.objectContaining({
         kind: 'create-routine', routineKind: 'function', returns: { name: 'int' },
        deterministic: true, dataAccess: 'no-sql', security: 'invoker', body: 'RETURN 7', confirmed: true,
      }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'procedure:app.refresh_orders')?.createCommands[0])
      .toEqual(expect.objectContaining({ kind: 'create-routine', routineKind: 'procedure', dataAccess: 'contains-sql' }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'trigger:app.orders.orders_audit')).toEqual(expect.objectContaining({
      dependencies: ['table:app.orders'],
      createCommands: [expect.objectContaining({ kind: 'create-trigger', timing: 'after', events: ['insert'] })],
    }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'event:app.purge_orders')?.createCommands[0])
      .toEqual(expect.objectContaining({
        kind: 'create-event', schedule: { kind: 'every', amount: 1, unit: 'day' }, preserve: true, enabled: true,
      }))
    expect(snapshot.manifest.objects.find((object) => object.id === 'partition:app.orders.p2026')?.createCommands[0])
      .toEqual({
        kind: 'create-partition', schema: 'app', table: 'orders', name: 'p2026',
        definition: 'VALUES LESS THAN (1000)',
        initialize: { method: 'range', expression: 'id' }, confirmed: true,
      })
    expect(snapshot.manifest.objects.find((object) => object.id === 'partition:app.orders.pmax')?.createCommands[0])
      .toEqual({
        kind: 'create-partition', schema: 'app', table: 'orders', name: 'pmax',
        definition: 'VALUES LESS THAN (MAXVALUE)', confirmed: true,
      })
  })
})
