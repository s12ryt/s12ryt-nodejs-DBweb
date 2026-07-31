import { describe, expect, it, vi } from 'vitest'

import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { ExactJsonManifest, ExactJsonRecord } from './exact-json-format.js'
import {
  ExactJsonPackageWriter,
  type TransferStagedArtifactStore,
} from './exact-json-package-writer.js'
import { readSafeTar } from './safe-tar.js'
import { TransferOutputWriter, type TransferOutputStore } from './transfer-output-writer.js'

class MemoryArtifactStore implements TransferOutputStore, TransferStagedArtifactStore {
  readonly jobs = new Map<string, Map<number, Buffer>>()

  async put(jobId: string, index: number, plaintext: Uint8Array): Promise<void> {
    const chunks = this.jobs.get(jobId) ?? new Map<number, Buffer>()
    chunks.set(index, Buffer.from(plaintext))
    this.jobs.set(jobId, chunks)
  }

  async deleteJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId)
  }

  async list(jobId: string): Promise<Array<{ index: number; size: number }>> {
    return [...(this.jobs.get(jobId) ?? new Map()).entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, bytes]) => ({ index, size: bytes.length }))
  }

  async read(jobId: string, index: number): Promise<Buffer> {
    const value = this.jobs.get(jobId)?.get(index)
    if (!value) throw new Error('missing chunk')
    return Buffer.from(value)
  }
}

const jobId = '11111111-1111-4111-8111-111111111111'
const manifest: ExactJsonManifest = {
  kind: 'manifest',
  format: 'dbweb-exact-json',
  version: 1,
  tables: [
    { id: 'users', schema: 'public', table: 'users', columns: [{ name: 'id', type: 'bigint' }] },
    { id: 'orders', schema: 'sales', table: 'orders', columns: [{ name: 'total', type: 'decimal' }] },
  ],
}

describe('ExactJsonPackageWriter', () => {
  it('stages one multi-table NDJSON entry and streams it into a gzip tar package', async () => {
    const staging = new MemoryArtifactStore()
    const output = new MemoryArtifactStore()
    const writer = new ExactJsonPackageWriter(
      new TransferOutputWriter(staging, 17),
      staging,
      new TransferOutputWriter(output, 19),
    )
    const records = fromRecords([
      { kind: 'row', table: 'users', values: { id: tagged('bigint', '9007199254740993') } },
      { kind: 'row', table: 'orders', values: { total: tagged('decimal', '12.30') } },
    ])

    const result = await writer.write(jobId, manifest, records, { compression: 'gzip' })

    expect(result.bytes).toBeGreaterThan(0)
    expect(staging.jobs.has(jobId)).toBe(false)
    const entries = new Map<string, Buffer>()
    await readSafeTar(readJob(output, jobId), async (entry, content) => {
      entries.set(entry.path, Buffer.concat(await collect(content)))
    }, { compression: 'gzip' })
    expect([...entries.keys()]).toEqual(['data.ndjson'])
    expect(entries.get('data.ndjson')?.toString('utf8')).toContain('9007199254740993')
    expect(entries.get('data.ndjson')?.toString('utf8')).toContain('"table":"orders"')
  })

  it('cleans both staging and partial output when package generation fails', async () => {
    const staging = new MemoryArtifactStore()
    const output = new MemoryArtifactStore()
    const outputWriter = new TransferOutputWriter(output, 19)
    const deleteOutput = vi.spyOn(outputWriter, 'delete')
    const writer = new ExactJsonPackageWriter(
      new TransferOutputWriter(staging, 17),
      staging,
      outputWriter,
    )
    const invalidRecords = fromRecords([
      { kind: 'row', table: 'missing', values: { id: tagged('bigint', '1') } },
    ])

    await expect(writer.write(jobId, manifest, invalidRecords)).rejects.toMatchObject({
      code: 'EXACT_JSON_PACKAGE_FAILED',
    })
    expect(staging.jobs.has(jobId)).toBe(false)
    expect(output.jobs.has(jobId)).toBe(false)
    expect(deleteOutput).toHaveBeenCalledWith(jobId)
  })
})

function tagged(type: 'bigint' | 'decimal', value: string): TaggedDatabaseValue {
  return { kind: 'value', type, value }
}

async function* fromRecords(records: ExactJsonRecord[]): AsyncIterable<ExactJsonRecord> {
  yield* records
}

async function* readJob(store: MemoryArtifactStore, id: string): AsyncIterable<Buffer> {
  for (const chunk of await store.list(id)) yield await store.read(id, chunk.index)
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}
