import { describe, expect, it } from 'vitest'

import {
  SqlDumpManifestError,
  validateSqlDumpManifest,
  type SqlDumpManifest,
} from './sql-dump-manifest.js'

describe('SQL dump manifest', () => {
  it('validates a same-engine manifest with checksummed entries and unique object dependencies', () => {
    const manifest = manifestFixture()

    expect(validateSqlDumpManifest(manifest, 'postgres')).toEqual(manifest)
  })

  it.each([
    ['engine mismatch', { engine: 'mysql' }],
    ['unknown dependency', { objects: [{ ...manifestFixture().objects[0]!, dependencies: ['missing'] }] }],
    ['duplicate object', { objects: [manifestFixture().objects[0]!, manifestFixture().objects[0]!] }],
    ['invalid checksum', { entries: [{ ...manifestFixture().entries[0]!, sha256: 'not-a-checksum' }] }],
  ])('rejects %s', (_label, patch) => {
    const manifest = { ...manifestFixture(), ...patch }

    expect(() => validateSqlDumpManifest(manifest, 'postgres')).toThrowError(
      new SqlDumpManifestError('INVALID_SQL_DUMP_MANIFEST'),
    )
  })
})

function manifestFixture(): SqlDumpManifest {
  return {
    format: 'dbweb-sql-dump',
    version: 1,
    engine: 'postgres',
    serverVersion: '17.5',
    database: 'app',
    scope: { kind: 'schema', schema: 'public' },
    objects: [
      {
        id: 'schema:public',
        kind: 'schema',
        schema: 'public',
        name: 'public',
        dependencies: [],
        createCommands: [{ kind: 'create-schema', name: 'public' }],
        dropCommand: { kind: 'drop-schema', name: 'public', confirmed: true },
      },
      {
        id: 'table:public.orders',
        kind: 'table',
        schema: 'public',
        name: 'orders',
        dependencies: ['schema:public'],
        createCommands: [{
          kind: 'create-table',
          schema: 'public',
          name: 'orders',
          columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
          primaryKey: ['id'],
        }],
        dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
        dataEntry: 'data/public.orders.ndjson',
      },
      {
        id: 'view:public.order_view',
        kind: 'view',
        schema: 'public',
        name: 'order_view',
        dependencies: ['table:public.orders'],
        createCommands: [{
          kind: 'create-view',
          schema: 'public',
          name: 'order_view',
          query: 'SELECT id FROM public.orders',
          confirmed: true,
        }],
        dropCommand: { kind: 'drop-view', schema: 'public', name: 'order_view', confirmed: true },
      },
    ],
    entries: [{
      path: 'data/public.orders.ndjson',
      size: 42,
      sha256: 'a'.repeat(64),
      objectId: 'table:public.orders',
      kind: 'data',
    }],
  }
}
