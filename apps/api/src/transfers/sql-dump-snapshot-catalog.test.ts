import { describe, expect, it, vi } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import type { SqlDumpExportCatalogResult, SqlDumpExportPlan } from './sql-dump-export-service.js'
import {
  SqlDumpSnapshotCatalog,
  SqlDumpSnapshotCatalogError,
  type SqlDumpSnapshotSession,
} from './sql-dump-snapshot-catalog.js'

const connection: ResolvedConnection = {
  id: 'connection-1', name: 'Primary', engine: 'postgres', host: 'db', port: 5432,
  database: 'app', username: 'dbweb', password: 'secret', tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 }, ssh: { enabled: false },
}
const plan: SqlDumpExportPlan = {
  compression: 'gzip', scope: { kind: 'schema', schema: 'public' }, includeData: true,
}

describe('SqlDumpSnapshotCatalog', () => {
  it('keeps one snapshot open while the consumer reads staged entry content', async () => {
    const setup = createSetup()
    const catalog = new SqlDumpSnapshotCatalog(setup.factory)

    const result = await catalog.withSnapshot(connection, plan, new AbortController().signal, async (snapshot) => {
      expect(setup.open).toBe(true)
      let value = ''
      for await (const chunk of snapshot.entries[0]!.content) value += Buffer.from(chunk).toString('utf8')
      return value
    })

    expect(result).toBe('snapshot-row')
    expect(setup.calls).toEqual(['begin', 'inspect', 'entry', 'commit', 'close'])
  })

  it('rolls back and closes when inspection or the consumer fails', async () => {
    const setup = createSetup()
    const catalog = new SqlDumpSnapshotCatalog(setup.factory)

    await expect(catalog.withSnapshot(connection, plan, new AbortController().signal, async () => {
      throw new Error('consumer-secret')
    })).rejects.toEqual(new SqlDumpSnapshotCatalogError('SQL_DUMP_CATALOG_FAILED'))

    expect(setup.calls).toEqual(['begin', 'inspect', 'rollback', 'close'])
  })
})

function createSetup() {
  const calls: string[] = []
  let open = false
  const session: SqlDumpSnapshotSession = {
    begin: vi.fn(async () => { calls.push('begin'); open = true }),
    inspect: vi.fn(async (): Promise<SqlDumpExportCatalogResult> => {
      calls.push('inspect')
      return {
        manifest: {
          format: 'dbweb-sql-dump', version: 1, engine: 'postgres', serverVersion: '17.5',
          database: 'app', scope: plan.scope, objects: [{
            id: 'table:public.orders', kind: 'table', schema: 'public', name: 'orders', dependencies: [],
            createCommands: [{
              kind: 'create-table', schema: 'public', name: 'orders',
              columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
            }],
            dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
            dataEntry: 'data/public.orders.ndjson',
          }],
        },
        entries: [{
          path: 'data/public.orders.ndjson', objectId: 'table:public.orders', kind: 'data' as const,
          content: entry(),
        }],
        rows: 1,
        tables: 1,
      }
    }),
    commit: vi.fn(async () => { calls.push('commit'); open = false }),
    rollback: vi.fn(async () => { calls.push('rollback'); open = false }),
    close: vi.fn(async () => { calls.push('close'); open = false }),
  }
  async function* entry() { calls.push('entry'); yield Buffer.from('snapshot-row') }
  return {
    calls,
    get open() { return open },
    factory: { open: vi.fn().mockResolvedValue(session) },
  }
}
