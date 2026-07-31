import { describe, expect, it } from 'vitest'

import { detectDdlCapabilities } from './ddl-capabilities.js'
import { DdlValidationError } from './ddl-command.js'
import { buildDdlStatements } from './ddl-sql-builder.js'

const postgres17 = detectDdlCapabilities('postgres', '17.5')
const mysql56 = detectDdlCapabilities('mysql', '5.6.51')
const mysql84 = detectDdlCapabilities('mysql', '8.4.5')

describe('index DDL statements', () => {
  it('以結構化欄位、排序與prefix建立一般索引', () => {
    expect(buildDdlStatements(postgres17, {
      kind: 'create-index', schema: 'public', table: 'orders', name: 'orders_customer_idx',
      method: 'btree', unique: false, parts: [{ column: 'customer_id', order: 'desc' }],
      confirmed: false,
    })).toEqual([
      'CREATE INDEX "orders_customer_idx" ON "public"."orders" USING btree ("customer_id" DESC)',
    ])
    expect(buildDdlStatements(mysql56, {
      kind: 'create-index', schema: 'app', table: 'articles', name: 'articles_title_idx',
      method: 'btree', unique: true, parts: [{ column: 'title', prefixLength: 64, order: 'asc' }],
      confirmed: false,
    })).toEqual([
      'CREATE UNIQUE INDEX `articles_title_idx` USING BTREE ON `app`.`articles` (`title`(64) ASC)',
    ])
  })

  it('進階與重負載索引要求確認並限制原文片段', () => {
    expect(() => buildDdlStatements(postgres17, {
      kind: 'create-index', schema: 'public', table: 'orders', name: 'orders_search_idx',
      method: 'gin', unique: false, parts: [{ expression: 'to_tsvector(\'simple\', title)' }],
      predicate: 'archived_at IS NULL', confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))

    expect(buildDdlStatements(postgres17, {
      kind: 'create-index', schema: 'public', table: 'orders', name: 'orders_search_idx',
      method: 'gin', unique: false, parts: [{ expression: 'to_tsvector(\'simple\', title)' }],
      predicate: 'archived_at IS NULL', confirmed: true,
    })).toEqual([
      'CREATE INDEX "orders_search_idx" ON "public"."orders" USING gin ((to_tsvector(\'simple\', title))) WHERE archived_at IS NULL',
    ])

    expect(() => buildDdlStatements(postgres17, {
      kind: 'create-index', schema: 'public', table: 'orders', name: 'bad_idx',
      method: 'btree', unique: false, parts: [{ expression: 'id); DROP TABLE orders; --' }],
      confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_FRAGMENT'))
    expect(() => buildDdlStatements(mysql84, {
      kind: 'create-index', schema: 'app', table: 'articles', name: 'search_idx',
      method: 'fulltext', unique: false, parts: [{ column: 'body' }], confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
  })

  it('拒絕方言不支援的索引能力與所有未確認刪除', () => {
    expect(() => buildDdlStatements(mysql84, {
      kind: 'create-index', schema: 'app', table: 'orders', name: 'partial_idx',
      method: 'btree', unique: false, parts: [{ column: 'id' }],
      predicate: 'id > 10', confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
    expect(() => buildDdlStatements(postgres17, {
      kind: 'drop-index', schema: 'public', table: 'orders', name: 'orders_idx', confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
    expect(buildDdlStatements(mysql84, {
      kind: 'drop-index', schema: 'app', table: 'orders', name: 'orders_idx', confirmed: true,
    })).toEqual(['DROP INDEX `orders_idx` ON `app`.`orders`'])
  })
})

describe('constraint DDL statements', () => {
  it('建立unique並要求確認primary key', () => {
    expect(buildDdlStatements(postgres17, {
      kind: 'add-constraint', schema: 'public', table: 'orders', name: 'orders_code_key',
      constraint: { kind: 'unique', columns: ['tenant_id', 'code'] }, confirmed: false,
    })).toEqual([
      'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_code_key" UNIQUE ("tenant_id", "code")',
    ])
    expect(() => buildDdlStatements(postgres17, {
      kind: 'add-constraint', schema: 'public', table: 'orders', name: 'orders_pkey',
      constraint: { kind: 'primary-key', columns: ['id'] }, confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
  })

  it('建立結構化foreign key並白名單化referential actions', () => {
    expect(buildDdlStatements(mysql84, {
      kind: 'add-constraint', schema: 'app', table: 'orders', name: 'orders_customer_fk',
      constraint: {
        kind: 'foreign-key', columns: ['customer_id'], referenceSchema: 'app',
        referenceTable: 'customers', referenceColumns: ['id'],
        onDelete: 'cascade', onUpdate: 'restrict',
      },
      confirmed: true,
    })).toEqual([
      'ALTER TABLE `app`.`orders` ADD CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
    ])
    expect(() => buildDdlStatements(postgres17, {
      kind: 'add-constraint', schema: 'public', table: 'orders', name: 'orders_customer_fk',
      constraint: {
        kind: 'foreign-key', columns: ['customer_id'], referenceSchema: 'public',
        referenceTable: 'customers', referenceColumns: ['id'], onDelete: 'cascade; drop table x',
      },
      confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_OPTION'))
  })

  it('依版本拒絕MySQL CHECK並限制expression，刪除約束一律確認', () => {
    expect(() => buildDdlStatements(mysql56, {
      kind: 'add-constraint', schema: 'app', table: 'orders', name: 'positive_total',
      constraint: { kind: 'check', expression: 'total >= 0' }, confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
    expect(buildDdlStatements(mysql84, {
      kind: 'add-constraint', schema: 'app', table: 'orders', name: 'positive_total',
      constraint: { kind: 'check', expression: 'total >= 0' }, confirmed: true,
    })).toEqual([
      'ALTER TABLE `app`.`orders` ADD CONSTRAINT `positive_total` CHECK (total >= 0)',
    ])
    expect(() => buildDdlStatements(mysql84, {
      kind: 'add-constraint', schema: 'app', table: 'orders', name: 'bad_check',
      constraint: { kind: 'check', expression: 'total >= 0 /* bypass */' }, confirmed: true,
    })).toThrow(new DdlValidationError('DDL_INVALID_FRAGMENT'))
    expect(() => buildDdlStatements(postgres17, {
      kind: 'drop-constraint', schema: 'public', table: 'orders', name: 'orders_code_key',
      constraintKind: 'unique', confirmed: false,
    })).toThrow(new DdlValidationError('DDL_CONFIRMATION_REQUIRED'))
  })

  it('依MySQL約束種類產生刪除語法並拒絕不支援的FK動作', () => {
    expect(buildDdlStatements(mysql84, {
      kind: 'drop-constraint', schema: 'app', table: 'orders', name: 'orders_customer_fk',
      constraintKind: 'foreign-key', confirmed: true,
    })).toEqual(['ALTER TABLE `app`.`orders` DROP FOREIGN KEY `orders_customer_fk`'])
    expect(buildDdlStatements(mysql84, {
      kind: 'drop-constraint', schema: 'app', table: 'orders', name: 'orders_pkey',
      constraintKind: 'primary-key', confirmed: true,
    })).toEqual(['ALTER TABLE `app`.`orders` DROP PRIMARY KEY'])
    expect(buildDdlStatements(mysql84, {
      kind: 'drop-constraint', schema: 'app', table: 'orders', name: 'orders_code_key',
      constraintKind: 'unique', confirmed: true,
    })).toEqual(['ALTER TABLE `app`.`orders` DROP INDEX `orders_code_key`'])
    expect(buildDdlStatements(mysql84, {
      kind: 'drop-constraint', schema: 'app', table: 'orders', name: 'positive_total',
      constraintKind: 'check', confirmed: true,
    })).toEqual(['ALTER TABLE `app`.`orders` DROP CHECK `positive_total`'])

    expect(() => buildDdlStatements(mysql84, {
      kind: 'add-constraint', schema: 'app', table: 'orders', name: 'orders_customer_fk',
      constraint: {
        kind: 'foreign-key', columns: ['customer_id'], referenceSchema: 'app',
        referenceTable: 'customers', referenceColumns: ['id'], onDelete: 'set default',
      },
      confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })

  it('拒絕方言不允許的unique索引方法組合', () => {
    expect(() => buildDdlStatements(postgres17, {
      kind: 'create-index', schema: 'public', table: 'orders', name: 'unique_hash_idx',
      method: 'hash', unique: true, parts: [{ column: 'code' }], confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
    expect(() => buildDdlStatements(mysql84, {
      kind: 'create-index', schema: 'app', table: 'articles', name: 'unique_search_idx',
      method: 'fulltext', unique: true, parts: [{ column: 'body' }], confirmed: true,
    })).toThrow(new DdlValidationError('DDL_CAPABILITY_UNSUPPORTED'))
  })
})
