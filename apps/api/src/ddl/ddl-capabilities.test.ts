import { describe, expect, it } from 'vitest'

import { detectDdlCapabilities } from './ddl-capabilities.js'

describe('detectDdlCapabilities', () => {
  it('以 PostgreSQL 9.6 最低能力提供可交易核心 DDL 與型別白名單', () => {
    const capabilities = detectDdlCapabilities('postgres', 'PostgreSQL 9.6.24 on x86_64')

    expect(capabilities).toMatchObject({
      engine: 'postgres',
      version: { major: 9, minor: 6, patch: 24, assumedMinimum: false },
      transactionalDdl: true,
      database: { create: true, drop: true, rename: true, owner: true },
      schema: { create: true, drop: true, rename: true, owner: true, databaseAlias: false },
      table: { create: true, drop: true, rename: true, owner: true, storageOptions: false },
      column: { identity: false, rename: true },
      constraint: { check: true, foreignKey: true, primaryKey: true, unique: true },
      index: {
        methods: ['btree', 'hash', 'gin', 'gist', 'brin'],
        expression: true,
        partial: true,
        prefixLength: false,
      },
    })
    expect(capabilities.columnTypes).toEqual(expect.arrayContaining([
      'bigint', 'boolean', 'bytea', 'date', 'json', 'jsonb', 'numeric',
      'text', 'timestamp', 'timestamptz', 'uuid', 'varchar',
    ]))
  })

  it('依 PostgreSQL 新版開放 identity 且未知版本降級到 9.6', () => {
    expect(detectDdlCapabilities('postgres', '17.5 (Debian 17.5-1)')).toMatchObject({
      version: { major: 17, minor: 5, patch: 0, assumedMinimum: false },
      column: { identity: true },
    })
    expect(detectDdlCapabilities('postgres', 'development build')).toMatchObject({
      version: { major: 9, minor: 6, patch: 0, assumedMinimum: true },
      column: { identity: false },
    })
  })

  it('限制 MySQL 5.6 不受支援的 CHECK、generated column 與現代 rename', () => {
    const capabilities = detectDdlCapabilities('mysql', '5.6.51-log')

    expect(capabilities).toMatchObject({
      engine: 'mysql',
      version: { major: 5, minor: 6, patch: 51, assumedMinimum: false },
      transactionalDdl: false,
      database: { create: true, drop: true, rename: false, owner: false },
      schema: { create: true, drop: true, rename: false, owner: false, databaseAlias: true },
      table: { create: true, drop: true, rename: true, owner: false, storageOptions: true },
      column: {
        generated: false,
        identity: true,
        rename: true,
        renameSyntax: 'change-column',
      },
      constraint: { check: false, foreignKey: true, primaryKey: true, unique: true },
      index: {
        methods: ['btree', 'hash', 'fulltext'],
        expression: false,
        partial: false,
        prefixLength: true,
      },
    })
    expect(capabilities.columnTypes).not.toContain('json')
  })

  it('依 MySQL 8.4 開放強制 CHECK、generated column、rename 與 JSON', () => {
    const capabilities = detectDdlCapabilities('mysql', '8.4.5 MySQL Community Server - GPL')

    expect(capabilities).toMatchObject({
      version: { major: 8, minor: 4, patch: 5, assumedMinimum: false },
      column: {
        generated: true,
        identity: true,
        rename: true,
        renameSyntax: 'rename-column',
      },
      constraint: { check: true },
    })
    expect(capabilities.columnTypes).toContain('json')
  })

  it('未知 MySQL 版本採 5.6 最低能力而非猜測新功能', () => {
    expect(detectDdlCapabilities('mysql', '')).toMatchObject({
      version: { major: 5, minor: 6, patch: 0, assumedMinimum: true },
      transactionalDdl: false,
      column: { generated: false, rename: true, renameSyntax: 'change-column' },
      constraint: { check: false },
    })
  })

  it('依 PostgreSQL 版本區分進階物件能力', () => {
    expect(detectDdlCapabilities('postgres', 'PostgreSQL 9.6.24')).toMatchObject({
      advanced: {
        view: true,
        materializedView: true,
        sequence: true,
        enum: true,
        domain: true,
        function: true,
        procedure: false,
        trigger: true,
        partition: false,
        extension: true,
        event: false,
      },
    })
    expect(detectDdlCapabilities('postgres', 'PostgreSQL 10.23')).toMatchObject({
      advanced: { partition: true, procedure: false },
    })
    expect(detectDdlCapabilities('postgres', 'PostgreSQL 11.22')).toMatchObject({
      advanced: { partition: true, procedure: true },
    })
  })

  it('只向 MySQL 開放其支援的進階物件', () => {
    expect(detectDdlCapabilities('mysql', '5.6.51')).toMatchObject({
      advanced: {
        view: true,
        materializedView: false,
        sequence: false,
        enum: false,
        domain: false,
        function: true,
        procedure: true,
        trigger: true,
        partition: true,
        extension: false,
        event: true,
      },
    })
  })
})
