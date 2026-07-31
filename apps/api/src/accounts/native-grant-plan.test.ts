import { describe, expect, it } from 'vitest'

import {
  NativeGrantValidationError,
  buildNativeGrantPlan,
  type NativeGrantCommand,
} from './native-grant-plan.js'

describe('native grant plan', () => {
  it('builds transactional PostgreSQL database, schema, and table grants', () => {
    const plan = buildNativeGrantPlan('postgres', {
      kind: 'grant',
      identity: { engine: 'postgres', username: 'report"reader' },
      changes: [
        { scope: 'database', database: 'analytics', privileges: ['connect'] },
        { scope: 'schema', database: 'analytics', schema: 'reporting', privileges: ['usage', 'create'] },
        {
          scope: 'table',
          database: 'analytics',
          schema: 'reporting',
          table: 'monthly totals',
          privileges: ['select', 'insert', 'update', 'delete', 'references'],
        },
      ],
    })

    expect(plan).toEqual({
      transactional: true,
      targetDatabase: 'analytics',
      statements: [
        'GRANT CONNECT ON DATABASE "analytics" TO "report""reader"',
        'GRANT USAGE, CREATE ON SCHEMA "reporting" TO "report""reader"',
        'GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLE "reporting"."monthly totals" TO "report""reader"',
      ],
    })
  })

  it('builds nontransactional MySQL database and table grants without grant option', () => {
    const plan = buildNativeGrantPlan('mysql', {
      kind: 'grant',
      identity: { engine: 'mysql', username: "app'reader", host: '10.%' },
      changes: [
        {
          scope: 'database',
          database: 'app_data',
          privileges: ['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'index', 'references'],
        },
        {
          scope: 'table',
          database: 'app_data',
          table: 'orders',
          privileges: ['select'],
        },
      ],
    })

    expect(plan).toEqual({
      transactional: false,
      targetDatabase: 'app_data',
      statements: [
        "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON `app\\_data`.* TO 'app''reader'@'10.%'",
        "GRANT SELECT ON `app_data`.`orders` TO 'app''reader'@'10.%'",
      ],
    })
    expect(plan.statements.join(' ')).not.toContain('GRANT OPTION')
  })

  it('requires confirmation for batch revoke', () => {
    const command: NativeGrantCommand = {
      kind: 'revoke',
      identity: { engine: 'postgres', username: 'reader' },
      changes: [
        { scope: 'database', database: 'analytics', privileges: ['connect'] },
        { scope: 'schema', database: 'analytics', schema: 'reporting', privileges: ['usage'] },
      ],
    }

    expect(() => buildNativeGrantPlan('postgres', command)).toThrowError(
      new NativeGrantValidationError('NATIVE_GRANT_CONFIRMATION_REQUIRED'),
    )
    expect(buildNativeGrantPlan('postgres', { ...command, confirmed: true }).statements).toEqual([
      'REVOKE CONNECT ON DATABASE "analytics" FROM "reader"',
      'REVOKE USAGE ON SCHEMA "reporting" FROM "reader"',
    ])
  })

  it('rejects protected databases, mismatched engines, and unsupported privileges', () => {
    expect(() => buildNativeGrantPlan('postgres', {
      kind: 'grant',
      identity: { engine: 'postgres', username: 'reader' },
      changes: [{ scope: 'database', database: 'template1', privileges: ['connect'] }],
    })).toThrowError(new NativeGrantValidationError('SYSTEM_DATABASE_PROTECTED'))

    expect(() => buildNativeGrantPlan('mysql', {
      kind: 'grant',
      identity: { engine: 'mysql', username: 'reader', host: '%' },
      changes: [{ scope: 'database', database: 'mysql', privileges: ['select'] }],
    })).toThrowError(new NativeGrantValidationError('SYSTEM_DATABASE_PROTECTED'))

    expect(() => buildNativeGrantPlan('postgres', {
      kind: 'grant',
      identity: { engine: 'mysql', username: 'reader', host: '%' },
      changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
    })).toThrowError(new NativeGrantValidationError('INVALID_NATIVE_GRANT'))

    expect(() => buildNativeGrantPlan('postgres', {
      kind: 'grant',
      identity: { engine: 'postgres', username: 'reader' },
      changes: [{ scope: 'table', database: 'analytics', schema: 'public', table: 'orders', privileges: ['alter'] }],
    })).toThrowError(new NativeGrantValidationError('UNSUPPORTED_NATIVE_PRIVILEGE'))
  })

  it('rejects malformed targets, duplicate privileges, and oversized batches', () => {
    expect(() => buildNativeGrantPlan('mysql', {
      kind: 'grant',
      identity: { engine: 'mysql', username: 'reader', host: '%' },
      changes: [{ scope: 'table', database: 'app', table: 'bad\u0000table', privileges: ['select'] }],
    })).toThrowError(new NativeGrantValidationError('INVALID_NATIVE_GRANT'))

    expect(() => buildNativeGrantPlan('mysql', {
      kind: 'grant',
      identity: { engine: 'mysql', username: 'reader', host: '%' },
      changes: [{ scope: 'table', database: 'app', table: 'orders', privileges: ['select', 'select'] }],
    })).toThrowError(new NativeGrantValidationError('INVALID_NATIVE_GRANT'))

    expect(() => buildNativeGrantPlan('postgres', {
      kind: 'grant',
      identity: { engine: 'postgres', username: 'reader' },
      changes: Array.from({ length: 101 }, (_, index) => ({
        scope: 'table' as const,
        database: 'analytics',
        schema: 'public',
        table: `table_${index}`,
        privileges: ['select' as const],
      })),
    })).toThrowError(new NativeGrantValidationError('INVALID_NATIVE_GRANT'))
  })
})
