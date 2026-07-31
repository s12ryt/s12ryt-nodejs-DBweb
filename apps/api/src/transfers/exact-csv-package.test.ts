import { describe, expect, it } from 'vitest'

import type { TaggedDatabaseValue } from '../data/tagged-value.js'
import type { ExactCsvSidecar } from './exact-csv-format.js'
import { encodeExactCsv } from './exact-csv-format.js'
import {
  ExactCsvPackageError,
  ExactCsvPackageWriter,
  readExactCsvPackage,
  type TransferStagedArtifactStore,
} from './exact-csv-package.js'
import { readSafeTar, writeSafeTar } from './safe-tar.js'
import { TransferOutputWriter, type TransferOutputStore } from './transfer-output-writer.js'

class MemoryArtifactStore implements TransferOutputStore, TransferStagedArtifactStore {
  readonly jobs = new Map<string, Map<number, Buffer>>()

  async put(jobId: string, index: number, plaintext: Uint8Array): Promise<void> {
    const chunks = this.jobs.get(jobId) ?? new Map<number, Buffer>()
    chunks.set(index, Buffer.from(plaintext))
    this.jobs.set(jobId, chunks)
  }

  async deleteJob(jobId: string): Promise<void> { this.jobs.delete(jobId) }

  async list(jobId: string): Promise<Array<{ index: number; size: number }>> {
    return [...(this.jobs.get(jobId) ?? new Map()).entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, bytes]) => ({ index, size: bytes.length }))
  }

  async read(jobId: string, index: number): Promise<Buffer> {
    const value = this.jobs.get(jobId)?.get(index)
    if (!value) throw new Error('missing')
    return Buffer.from(value)
  }
}

const jobId = '11111111-1111-4111-8111-111111111111'
const sidecar: ExactCsvSidecar = {
  format: 'dbweb-exact-csv', version: 1, schema: 'public', table: 'users',
  delimiter: ',', bom: true,
  columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'string' }],
}
const rows = [{
  id: { kind: 'value', type: 'bigint', value: '9007199254740993' },
  name: { kind: 'value', type: 'string', value: 'Ada' },
}] satisfies Array<Record<string, TaggedDatabaseValue>>

describe('exact CSV package', () => {
  it.each(['none', 'gzip'] as const)('writes and reads a streamed %s package', async (compression) => {
    const staging = new MemoryArtifactStore()
    const output = new MemoryArtifactStore()
    const writer = new ExactCsvPackageWriter(
      new TransferOutputWriter(staging, 13), staging,
      new TransferOutputWriter(output, 17),
    )

    const result = await writer.write(jobId, sidecar, from(rows), { compression })

    expect(result.bytes).toBeGreaterThan(0)
    expect(staging.jobs.has(jobId)).toBe(false)
    const entries: string[] = []
    await readSafeTar(readJob(output, jobId), async (entry) => { entries.push(entry.path) }, { compression })
    expect(entries).toEqual(['sidecar.json', 'data.csv'])
    const received: Array<Record<string, TaggedDatabaseValue>> = []
    await readExactCsvPackage(readJob(output, jobId), async (decodedSidecar, decodedRows) => {
      expect(decodedSidecar).toEqual(sidecar)
      for await (const row of decodedRows) received.push(row)
    }, { compression })
    expect(received).toEqual(rows)
  })

  it('rejects missing, reordered, and additional entries', async () => {
    const sidecarBytes = Buffer.from(JSON.stringify(sidecar))
    const csvBytes = Buffer.concat(await collect(encodeExactCsv(sidecar, from(rows))))
    const archive = (entries: Array<{ path: string; bytes: Buffer }>) => writeSafeTar(entries.map((entry) => ({
      path: entry.path, size: entry.bytes.length, content: from([entry.bytes]),
    })))

    await expect(readExactCsvPackage(archive([{ path: 'data.csv', bytes: csvBytes }]), async () => undefined))
      .rejects.toEqual(new ExactCsvPackageError('INVALID_EXACT_CSV_PACKAGE'))
    await expect(readExactCsvPackage(archive([
      { path: 'data.csv', bytes: csvBytes }, { path: 'sidecar.json', bytes: sidecarBytes },
    ]), async () => undefined)).rejects.toEqual(new ExactCsvPackageError('INVALID_EXACT_CSV_PACKAGE'))
    await expect(readExactCsvPackage(archive([
      { path: 'sidecar.json', bytes: sidecarBytes }, { path: 'data.csv', bytes: csvBytes },
      { path: 'extra.txt', bytes: Buffer.from('x') },
    ]), async () => undefined)).rejects.toEqual(new ExactCsvPackageError('INVALID_EXACT_CSV_PACKAGE'))
  })

  it('preserves handler errors and cleans partial output failures', async () => {
    const staging = new MemoryArtifactStore()
    const output = new MemoryArtifactStore()
    const writer = new ExactCsvPackageWriter(
      new TransferOutputWriter(staging, 13), staging,
      new TransferOutputWriter(output, 17),
    )
    const invalidRows = [{ id: rows[0]!.id }] as Array<Record<string, TaggedDatabaseValue>>

    await expect(writer.write(jobId, sidecar, from(invalidRows))).rejects.toEqual(
      new ExactCsvPackageError('EXACT_CSV_PACKAGE_FAILED'),
    )
    expect(staging.jobs.has(jobId)).toBe(false)
    expect(output.jobs.has(jobId)).toBe(false)

    const sidecarBytes = Buffer.from(JSON.stringify(sidecar))
    const csvBytes = Buffer.concat(await collect(encodeExactCsv(sidecar, from(rows))))
    const failure = new Error('HANDLER_FAILURE')
    await expect(readExactCsvPackage(writeSafeTar([
      { path: 'sidecar.json', size: sidecarBytes.length, content: from([sidecarBytes]) },
      { path: 'data.csv', size: csvBytes.length, content: from([csvBytes]) },
    ]), async () => { throw failure })).rejects.toBe(failure)
  })
})

async function* from<T>(values: T[]): AsyncIterable<T> { yield* values }

async function* readJob(store: MemoryArtifactStore, id: string): AsyncIterable<Buffer> {
  for (const chunk of await store.list(id)) yield await store.read(id, chunk.index)
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return values
}
