import { describe, expect, it } from 'vitest'

import type { SqlDumpManifest } from './sql-dump-manifest.js'
import {
  SqlRestorePlanError,
  buildSqlRestorePlan,
} from './sql-restore-plan.js'

describe('SQL restore plan', () => {
  it('orders dependencies and keeps data before dependent views', () => {
    const plan = buildSqlRestorePlan(manifestFixture(), {
      engine: 'postgres',
      targetDatabase: 'app_restore',
      existingObjectIds: [],
      mode: 'stop',
      supportedKinds: ['schema', 'table', 'view'],
    })

    expect(plan.dropObjectIds).toEqual([])
    expect(plan.steps.map((step) => `${step.phase}:${step.objectId}`)).toEqual([
      'structure:schema:public',
      'structure:table:public.orders',
      'data:table:public.orders',
      'dependent:view:public.order_view',
    ])
  })

  it('creates partition children after their parent and before restoring parent data', () => {
    const manifest = manifestFixture()
    manifest.objects.push({
      id: 'partition:public.orders.orders_low',
      kind: 'partition',
      schema: 'public',
      name: 'orders_low',
      dependencies: ['table:public.orders'],
      createCommands: [{
        kind: 'create-partition', schema: 'public', table: 'orders', name: 'orders_low',
        definition: 'FOR VALUES FROM (0) TO (100)', confirmed: true,
      }],
      dropCommand: {
        kind: 'drop-partition', schema: 'public', table: 'orders', name: 'orders_low', confirmed: true,
      },
    })

    const plan = buildSqlRestorePlan(manifest, {
      engine: 'postgres', targetDatabase: 'app_restore', existingObjectIds: [], mode: 'stop',
      supportedKinds: ['schema', 'table', 'partition', 'view'],
    })

    expect(plan.steps.map((step) => `${step.phase}:${step.objectId}`)).toEqual([
      'structure:schema:public',
      'structure:table:public.orders',
      'structure:partition:public.orders.orders_low',
      'data:table:public.orders',
      'dependent:view:public.order_view',
    ])
  })

  it('stops on existing objects unless an immutable drop plan is confirmed with the target database name', () => {
    const manifest = manifestFixture()
    const input = {
      engine: 'postgres' as const,
      targetDatabase: 'app_restore',
      existingObjectIds: ['table:public.orders', 'view:public.order_view'],
      supportedKinds: ['schema', 'table', 'view'] as const,
    }

    expect(() => buildSqlRestorePlan(manifest, { ...input, mode: 'stop' })).toThrowError(
      new SqlRestorePlanError('RESTORE_OBJECT_EXISTS'),
    )
    expect(() => buildSqlRestorePlan(manifest, {
      ...input,
      mode: 'drop-and-recreate',
      confirmationDatabase: 'wrong',
    })).toThrowError(new SqlRestorePlanError('RESTORE_CONFIRMATION_REQUIRED'))

    const plan = buildSqlRestorePlan(manifest, {
      ...input,
      mode: 'drop-and-recreate',
      confirmationDatabase: 'app_restore',
    })
    expect(plan.dropObjectIds).toEqual(['view:public.order_view', 'table:public.orders'])
    expect(plan.dropCommands).toEqual([
      manifest.objects[2]!.dropCommand,
      manifest.objects[1]!.dropCommand,
    ])
  })

  it('skips unsupported objects and every dependent only when explicitly requested', () => {
    const manifest = manifestFixture()

    expect(() => buildSqlRestorePlan(manifest, {
      engine: 'postgres',
      targetDatabase: 'app_restore',
      existingObjectIds: [],
      mode: 'stop',
      supportedKinds: ['schema'],
    })).toThrowError(new SqlRestorePlanError('RESTORE_CAPABILITY_UNSUPPORTED'))

    const plan = buildSqlRestorePlan(manifest, {
      engine: 'postgres',
      targetDatabase: 'app_restore',
      existingObjectIds: [],
      mode: 'stop',
      supportedKinds: ['schema'],
      skipUnsupported: true,
    })
    expect(plan.skippedObjectIds).toEqual(['table:public.orders', 'view:public.order_view'])
    expect(plan.steps.map((step) => step.objectId)).toEqual(['schema:public'])
  })

  it('rejects cyclic dependencies instead of executing an unstable order', () => {
    const manifest = manifestFixture()
    manifest.objects[1]!.dependencies = ['view:public.order_view']

    expect(() => buildSqlRestorePlan(manifest, {
      engine: 'postgres',
      targetDatabase: 'app_restore',
      existingObjectIds: [],
      mode: 'stop',
      supportedKinds: ['schema', 'table', 'view'],
    })).toThrowError(new SqlRestorePlanError('RESTORE_DEPENDENCY_CYCLE'))
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
