import { describe, expect, it } from 'vitest'

import { detectDdlCapabilities } from './ddl-capabilities.js'
import { DdlValidationError } from './ddl-command.js'
import { buildDdlStatements } from './ddl-sql-builder.js'

const postgres96 = detectDdlCapabilities('postgres', '9.6.24')
const postgres11 = detectDdlCapabilities('postgres', '11.22')
const mysql56 = detectDdlCapabilities('mysql', '5.6.51')

describe('programmable DDL statements', () => {
  it('建立 PostgreSQL function並以不衝突的dollar quote保存原文body', () => {
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-routine', routineKind: 'function', schema: 'public', name: 'normalize_name',
      arguments: [{ name: 'input', type: { name: 'text' } }], returns: { name: 'text' },
      language: 'plpgsql', body: 'BEGIN RETURN lower(input); END;', replace: true,
      volatility: 'immutable', security: 'definer', strict: true, confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))

    expect(buildDdlStatements(postgres96, {
      kind: 'create-routine', routineKind: 'function', schema: 'public', name: 'normalize_name',
      arguments: [{ name: 'input', type: { name: 'text' } }], returns: { name: 'text' },
      language: 'plpgsql', body: 'BEGIN RETURN lower(input); END; -- $dbweb$', replace: true,
      volatility: 'immutable', security: 'definer', strict: true, confirmed: true,
    })).toEqual([
      'CREATE OR REPLACE FUNCTION "public"."normalize_name"("input" text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER STRICT AS $dbweb1$BEGIN RETURN lower(input); END; -- $dbweb$$dbweb1$',
    ])
  })

  it('依 PostgreSQL版本開放procedure並要求drop signature', () => {
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-routine', routineKind: 'procedure', schema: 'public', name: 'archive_orders',
      arguments: [], language: 'plpgsql', body: 'BEGIN NULL; END;', confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
    expect(buildDdlStatements(postgres11, {
      kind: 'create-routine', routineKind: 'procedure', schema: 'public', name: 'archive_orders',
      arguments: [{ name: 'cutoff', mode: 'in', type: { name: 'date' } }],
      language: 'plpgsql', body: 'BEGIN DELETE FROM orders WHERE created_at < cutoff; END;',
      security: 'invoker', confirmed: true,
    })).toEqual([
      'CREATE PROCEDURE "public"."archive_orders"(IN "cutoff" date) LANGUAGE plpgsql SECURITY INVOKER AS $dbweb$BEGIN DELETE FROM orders WHERE created_at < cutoff; END;$dbweb$',
    ])
    expect(buildDdlStatements(postgres11, {
      kind: 'drop-routine', routineKind: 'function', schema: 'public', name: 'normalize_name',
      argumentTypes: [{ name: 'text' }], cascade: true, confirmed: true,
    })).toEqual(['DROP FUNCTION "public"."normalize_name"(text) CASCADE'])
  })

  it('建立 MySQL procedure/function並拒絕缺少function return type', () => {
    expect(buildDdlStatements(mysql56, {
      kind: 'create-routine', routineKind: 'procedure', schema: 'app', name: 'archive_orders',
      arguments: [{ name: 'cutoff', mode: 'in', type: { name: 'date' } }],
      body: 'BEGIN DELETE FROM orders WHERE created_at < cutoff; END',
      security: 'definer', confirmed: true,
    })).toEqual([
      'CREATE PROCEDURE `app`.`archive_orders`(IN `cutoff` date) SQL SECURITY DEFINER BEGIN DELETE FROM orders WHERE created_at < cutoff; END',
    ])
    expect(() => buildDdlStatements(mysql56, {
      kind: 'create-routine', routineKind: 'function', schema: 'app', name: 'order_count',
      arguments: [], body: 'RETURN 1', confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_OPTION'))
  })

  it('以結構化事件建立 PostgreSQL 與 MySQL trigger', () => {
    expect(buildDdlStatements(postgres96, {
      kind: 'create-trigger', schema: 'public', table: 'orders', name: 'orders_audit',
      timing: 'after', events: ['insert', 'update'], forEach: 'row',
      functionSchema: 'public', functionName: 'audit_order', functionArguments: ['orders'],
      confirmed: true,
    })).toEqual([
      'CREATE TRIGGER "orders_audit" AFTER INSERT OR UPDATE ON "public"."orders" FOR EACH ROW EXECUTE PROCEDURE "public"."audit_order"(\'orders\')',
    ])
    expect(buildDdlStatements(mysql56, {
      kind: 'create-trigger', schema: 'app', table: 'orders', name: 'orders_audit',
      timing: 'before', events: ['insert'], forEach: 'row', body: 'SET NEW.created_at = NOW();',
      confirmed: true,
    })).toEqual([
      'CREATE TRIGGER `app`.`orders_audit` BEFORE INSERT ON `app`.`orders` FOR EACH ROW SET NEW.created_at = NOW();',
    ])
    expect(() => buildDdlStatements(mysql56, {
      kind: 'create-trigger', schema: 'app', table: 'orders', name: 'bad_trigger',
      timing: 'before', events: ['insert', 'update'], forEach: 'row', body: 'SET @x = 1',
      confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })

  it('以結構化排程建立 MySQL event', () => {
    expect(buildDdlStatements(mysql56, {
      kind: 'create-event', schema: 'app', name: 'purge_sessions',
      schedule: { kind: 'every', amount: 1, unit: 'day' },
      preserve: true, enabled: true, body: 'DELETE FROM sessions WHERE expires_at < NOW();',
      confirmed: true,
    })).toEqual([
      'CREATE EVENT `app`.`purge_sessions` ON SCHEDULE EVERY 1 DAY ON COMPLETION PRESERVE ENABLE DO DELETE FROM sessions WHERE expires_at < NOW();',
    ])
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-event', schema: 'public', name: 'purge_sessions',
      schedule: { kind: 'every', amount: 1, unit: 'day' }, body: 'DELETE FROM sessions',
      preserve: false, enabled: true, confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })
})

describe('partition DDL statements', () => {
  it('依方言建立與移除partition且拒絕未確認或不安全definition', () => {
    expect(buildDdlStatements(postgres11, {
      kind: 'create-partition', schema: 'public', table: 'events', name: 'events_2026',
      definition: 'FOR VALUES FROM (\'2026-01-01\') TO (\'2027-01-01\')', confirmed: true,
    })).toEqual([
      'CREATE TABLE "public"."events_2026" PARTITION OF "public"."events" FOR VALUES FROM (\'2026-01-01\') TO (\'2027-01-01\')',
    ])
    expect(buildDdlStatements(mysql56, {
      kind: 'create-partition', schema: 'app', table: 'events', name: 'events_2026',
      definition: 'VALUES LESS THAN (2027)', confirmed: true,
    })).toEqual([
      'ALTER TABLE `app`.`events` ADD PARTITION (PARTITION `events_2026` VALUES LESS THAN (2027))',
    ])
    expect(() => buildDdlStatements(mysql56, {
      kind: 'create-partition', schema: 'app', table: 'events', name: 'bad_partition',
      definition: 'VALUES LESS THAN (2027); DROP TABLE events', confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_FRAGMENT'))
    expect(() => buildDdlStatements(mysql56, {
      kind: 'drop-partition', schema: 'app', table: 'events', name: 'events_2026', confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
  })
})
