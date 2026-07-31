import { describe, expect, it } from 'vitest'

import { detectDdlCapabilities } from './ddl-capabilities.js'
import { DdlValidationError } from './ddl-command.js'
import { buildDdlStatements } from './ddl-sql-builder.js'

const postgres96 = detectDdlCapabilities('postgres', '9.6.24')
const mysql56 = detectDdlCapabilities('mysql', '5.6.51')

describe('advanced structured DDL statements', () => {
  it('建立與刪除 view，並要求原文 query 與破壞操作確認', () => {
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-view', schema: 'reporting', name: 'active_orders',
      query: 'SELECT id FROM public.orders WHERE archived_at IS NULL', replace: true,
      confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))

    expect(buildDdlStatements(postgres96, {
      kind: 'create-view', schema: 'reporting', name: 'active_orders',
      query: 'SELECT id FROM public.orders WHERE archived_at IS NULL;', replace: true,
      confirmed: true,
    })).toEqual([
      'CREATE OR REPLACE VIEW "reporting"."active_orders" AS SELECT id FROM public.orders WHERE archived_at IS NULL;',
    ])
    expect(buildDdlStatements(mysql56, {
      kind: 'drop-view', schema: 'app', name: 'active_orders', confirmed: true,
    })).toEqual(['DROP VIEW `app`.`active_orders`'])
  })

  it('管理 PostgreSQL materialized view 並拒絕 MySQL', () => {
    expect(buildDdlStatements(postgres96, {
      kind: 'create-materialized-view', schema: 'reporting', name: 'daily_totals',
      query: 'SELECT current_date AS day', withData: false, confirmed: true,
    })).toEqual([
      'CREATE MATERIALIZED VIEW "reporting"."daily_totals" AS SELECT current_date AS day WITH NO DATA',
    ])
    expect(buildDdlStatements(postgres96, {
      kind: 'refresh-materialized-view', schema: 'reporting', name: 'daily_totals',
      concurrently: true, confirmed: true,
    })).toEqual(['REFRESH MATERIALIZED VIEW CONCURRENTLY "reporting"."daily_totals"'])
    expect(() => buildDdlStatements(mysql56, {
      kind: 'create-materialized-view', schema: 'app', name: 'daily_totals',
      query: 'SELECT 1', withData: true, confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })

  it('以結構化數值選項管理 PostgreSQL sequence', () => {
    expect(buildDdlStatements(postgres96, {
      kind: 'create-sequence', schema: 'public', name: 'order_number_seq',
      start: 1000, increment: 5, minValue: 1000, maxValue: 9_999_999,
      cache: 20, cycle: true,
    })).toEqual([
      'CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 5 MINVALUE 1000 MAXVALUE 9999999 START WITH 1000 CACHE 20 CYCLE',
    ])
    expect(() => buildDdlStatements(mysql56, {
      kind: 'create-sequence', schema: 'app', name: 'order_number_seq', start: 1,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })

  it('管理 PostgreSQL enum與domain並驗證結構化型別', () => {
    expect(buildDdlStatements(postgres96, {
      kind: 'create-enum', schema: 'public', name: 'order_state', values: ['new', "customer's"],
    })).toEqual([
      'CREATE TYPE "public"."order_state" AS ENUM (\'new\', \'customer\'\'s\')',
    ])
    expect(buildDdlStatements(postgres96, {
      kind: 'create-domain', schema: 'public', name: 'positive_amount',
      baseType: { name: 'numeric', precision: 12, scale: 2 }, nullable: false,
      default: { kind: 'literal', value: 0 }, check: 'VALUE >= 0', confirmed: true,
    })).toEqual([
      'CREATE DOMAIN "public"."positive_amount" AS numeric(12,2) DEFAULT 0 NOT NULL CHECK (VALUE >= 0)',
    ])
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-domain', schema: 'public', name: 'unsafe_domain',
      baseType: { name: 'text' }, nullable: true,
      check: 'VALUE IS NOT NULL; DROP TABLE orders', confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_FRAGMENT'))
  })

  it('只允許安全token建立 extension且所有移除要求確認', () => {
    expect(buildDdlStatements(postgres96, {
      kind: 'create-extension', name: 'pgcrypto', schema: 'extensions', version: '1.3', cascade: true,
      confirmed: true,
    })).toEqual(['CREATE EXTENSION "pgcrypto" SCHEMA "extensions" VERSION \'1.3\' CASCADE'])
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-extension', name: 'pgcrypto', version: "1.3'; DROP DATABASE app; --", confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_OPTION'))
    expect(() => buildDdlStatements(postgres96, {
      kind: 'create-extension', name: 'pgcrypto', confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
    expect(() => buildDdlStatements(postgres96, {
      kind: 'drop-type', schema: 'public', name: 'order_state', cascade: false, confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
  })
})
