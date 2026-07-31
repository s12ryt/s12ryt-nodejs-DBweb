import { createHash, randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SqlDumpManifest } from './sql-dump-manifest.js'
import { readSqlDumpPackage } from './sql-dump-package.js'
import { SqlDumpPackageWriter } from './sql-dump-package-writer.js'
import type { TransferStagedArtifactStore } from './exact-json-package-writer.js'

describe('SQL dump package writer', () => {
  it('stages entries to derive checksums before streaming the final gzip package', async () => {
    const staging = new MemoryArtifacts()
    const output = new MemoryWriter(staging)
    const packages = new MemoryWriter(new MemoryArtifacts())
    const writer = new SqlDumpPackageWriter(output, staging, packages, () => randomUUID())

    const result = await writer.write('11111111-1111-4111-8111-111111111111', manifestDraft(), [
      { path: 'data/public.orders.ndjson', objectId: 'table:public.orders', kind: 'data', content: chunks('row-data') },
      { path: 'definitions/order_view.sql', objectId: 'view:public.order_view', kind: 'definition', content: chunks('view-body') },
    ], { compression: 'gzip' })

    expect(result.entries).toEqual([
      { path: 'data/public.orders.ndjson', objectId: 'table:public.orders', kind: 'data', size: 8, sha256: hash('row-data') },
      { path: 'definitions/order_view.sql', objectId: 'view:public.order_view', kind: 'definition', size: 9, sha256: hash('view-body') },
    ])
    const seen: string[] = []
    await readSqlDumpPackage(packages.store.readAll(result.jobId), async (_manifest, entry, content) => {
      let value = ''
      for await (const chunk of content) value += chunk.toString('utf8')
      seen.push(`${entry.path}:${value}`)
    }, { compression: 'gzip' })
    expect(seen).toEqual(['data/public.orders.ndjson:row-data', 'definitions/order_view.sql:view-body'])
    expect(staging.jobs.size).toBe(0)
  })

  it('cleans all staging and output artifacts when an entry stream fails', async () => {
    const staging = new MemoryArtifacts()
    const packageStore = new MemoryArtifacts()
    const writer = new SqlDumpPackageWriter(
      new MemoryWriter(staging), staging, new MemoryWriter(packageStore), () => randomUUID(),
    )

    await expect(writer.write('11111111-1111-4111-8111-111111111111', manifestDraft(), [
      { path: 'data/public.orders.ndjson', objectId: 'table:public.orders', kind: 'data', content: brokenChunks() },
    ])).rejects.toThrow('SQL_DUMP_PACKAGE_FAILED')
    expect(staging.jobs.size).toBe(0)
    expect(packageStore.jobs.size).toBe(0)
  })
})

class MemoryArtifacts implements TransferStagedArtifactStore {
  readonly jobs = new Map<string, Buffer[]>()

  async list(jobId: string) {
    return (this.jobs.get(jobId) ?? []).map((content, index) => ({
      index, size: content.length, checksum: hash(content),
    }))
  }

  async read(jobId: string, index: number) {
    const content = this.jobs.get(jobId)?.[index]
    if (!content) throw new Error('MISSING')
    return content
  }

  async *readAll(jobId: string) {
    for (const chunk of this.jobs.get(jobId) ?? []) yield chunk
  }

  async deleteJob(jobId: string) {
    this.jobs.delete(jobId)
  }
}

class MemoryWriter {
  constructor(readonly store: MemoryArtifacts) {}

  async write(jobId: string, content: AsyncIterable<Uint8Array>) {
    const values: Buffer[] = []
    const digest = createHash('sha256')
    let bytes = 0
    for await (const value of content) {
      const chunk = Buffer.from(value)
      values.push(chunk)
      digest.update(chunk)
      bytes += chunk.length
    }
    this.store.jobs.set(jobId, values)
    return { bytes, chunks: values.length, checksum: digest.digest('hex') }
  }

  delete(jobId: string) {
    return this.store.deleteJob(jobId)
  }
}

function manifestDraft(): Omit<SqlDumpManifest, 'entries'> {
  return {
    format: 'dbweb-sql-dump', version: 1, engine: 'postgres', serverVersion: '17.5', database: 'source',
    scope: { kind: 'schema', schema: 'public' }, objects: [
      {
        id: 'table:public.orders', kind: 'table', schema: 'public', name: 'orders', dependencies: [],
        createCommands: [{
          kind: 'create-table', schema: 'public', name: 'orders',
          columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
        }],
        dropCommand: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true },
        dataEntry: 'data/public.orders.ndjson',
      },
      {
        id: 'view:public.order_view', kind: 'view', schema: 'public', name: 'order_view', dependencies: ['table:public.orders'],
        createCommands: [{ kind: 'create-view', schema: 'public', name: 'order_view', query: 'SELECT id FROM public.orders', confirmed: true }],
        dropCommand: { kind: 'drop-view', schema: 'public', name: 'order_view', confirmed: true },
      },
    ],
  }
}

async function* chunks(value: string): AsyncIterable<Buffer> { yield Buffer.from(value) }
async function* brokenChunks(): AsyncIterable<Buffer> { yield Buffer.from('partial'); throw new Error('driver-secret') }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
