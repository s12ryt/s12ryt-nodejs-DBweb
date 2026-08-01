import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connections/connection-service.js'
import { MemoryConnectionRepository } from '../connections/memory-connection-repository.js'
import { SqlQueryService, type QueryAuditRecorder, type SqlGateway, type SqlStreamGateway } from '../query/sql-query-service.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { encodeExactJson, type ExactJsonManifest, type ExactJsonRecord } from './exact-json-format.js'

const MILLION = 1_000_000

describe('million-row streaming paths', () => {
  it('streams one million SQL rows as NDJSON without collecting the result set', async () => {
    const connections = new ConnectionService(
      new MemoryConnectionRepository(),
      new EnvelopeEncryption(Buffer.alloc(32, 8)),
      { postgres: { test: vi.fn() }, mysql: { test: vi.fn() } },
    )
    const profile = await connections.create({
      name: 'Load', engine: 'postgres', host: 'localhost', port: 5432, database: 'app',
      username: 'reader', password: 'secret', tls: { mode: 'disable' }, keepAlive: { enabled: false },
    }, 'admin')
    const buffered: SqlGateway = {
      execute: vi.fn(async () => ({ columns: [], rows: [], affectedRows: 0 })),
    }
    let produced = 0
    const streamed: SqlStreamGateway = {
      stream: vi.fn(async function* () {
        while (produced < MILLION) {
          produced += 1
          yield { id: produced }
        }
      }),
    }
    const audit: QueryAuditRecorder = { record: vi.fn(async () => undefined) }
    const service = new SqlQueryService(
      connections,
      { postgres: buffered, mysql: buffered },
      audit,
      undefined,
      { postgres: streamed, mysql: streamed },
    )
    let lines = 0
    let summary = ''
    for await (const line of service.stream('admin-1', 'admin', {
      queryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connectionId: profile.id,
      sql: 'SELECT id FROM million_rows',
      rowLimit: MILLION,
      byteLimit: 2 * 1024 * 1024 * 1024,
      timeoutMs: 300_000,
    })) {
      lines += 1
      summary = line
    }

    expect(produced).toBe(MILLION)
    expect(lines).toBe(MILLION + 2)
    expect(summary).toContain('"rowCount":1000000')
    expect(summary).toContain('"truncated":false')
  }, 120_000)

  it('encodes one million exact JSON transfer rows lazily', async () => {
    const manifest: ExactJsonManifest = {
      kind: 'manifest', format: 'dbweb-exact-json', version: 1,
      tables: [{ id: 'rows', schema: 'public', table: 'million_rows', columns: [{ name: 'id', type: 'bigint' }] }],
    }
    let produced = 0
    async function* records(): AsyncIterable<ExactJsonRecord> {
      while (produced < MILLION) {
        produced += 1
        yield {
          kind: 'row', table: 'rows',
          values: { id: { kind: 'value', type: 'bigint', value: String(produced) } },
        }
      }
    }
    let chunks = 0
    for await (const chunk of encodeExactJson(manifest, records())) {
      expect(chunk.byteLength).toBeGreaterThan(0)
      chunks += 1
    }

    expect(produced).toBe(MILLION)
    expect(chunks).toBe(MILLION + 1)
  }, 120_000)
})
