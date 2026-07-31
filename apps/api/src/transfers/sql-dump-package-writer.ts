import { randomUUID } from 'node:crypto'

import type { SqlDumpEntry, SqlDumpManifest } from './sql-dump-manifest.js'
import { writeSqlDumpPackage } from './sql-dump-package.js'
import type { TransferStagedArtifactStore } from './exact-json-package-writer.js'
import type { TransferOutputResult, TransferOutputWriter } from './transfer-output-writer.js'

export interface SqlDumpEntrySource {
  path: string
  objectId: string
  kind: SqlDumpEntry['kind']
  content: AsyncIterable<Uint8Array>
}

export interface SqlDumpPackageWriteResult extends TransferOutputResult {
  jobId: string
  manifest: SqlDumpManifest
  entries: SqlDumpEntry[]
}

export class SqlDumpPackageWriterError extends Error {
  constructor(readonly code: 'SQL_DUMP_PACKAGE_FAILED') {
    super(code)
    this.name = 'SqlDumpPackageWriterError'
  }
}

interface StagedEntry {
  id: string
  entry: SqlDumpEntry
  chunks: number
}

export class SqlDumpPackageWriter {
  constructor(
    private readonly stagingWriter: Pick<TransferOutputWriter, 'write'>,
    private readonly stagingStore: TransferStagedArtifactStore,
    private readonly outputWriter: Pick<TransferOutputWriter, 'delete' | 'write'>,
    private readonly createStagingId: () => string = randomUUID,
  ) {}

  async write(
    jobId: string,
    manifestDraft: Omit<SqlDumpManifest, 'entries'>,
    sources: SqlDumpEntrySource[],
    options: { compression?: 'none' | 'gzip'; signal?: AbortSignal } = {},
  ): Promise<SqlDumpPackageWriteResult> {
    const staged: StagedEntry[] = []
    try {
      for (const source of sources) {
        const id = this.createStagingId()
        const result = await this.stagingWriter.write(id, source.content, options.signal)
        staged.push({
          id,
          chunks: result.chunks,
          entry: {
            path: source.path,
            objectId: source.objectId,
            kind: source.kind,
            size: result.bytes,
            sha256: result.checksum,
          },
        })
      }

      const entries = staged.map(({ entry }) => entry)
      const manifest: SqlDumpManifest = { ...manifestDraft, entries }
      const archive = writeSqlDumpPackage(
        manifest,
        this.packageEntries(staged),
        { compression: options.compression ?? 'none' },
      )
      const result = await this.outputWriter.write(jobId, archive, options.signal)
      return { jobId, manifest, entries, ...result }
    } catch {
      await this.outputWriter.delete(jobId).catch(() => undefined)
      throw new SqlDumpPackageWriterError('SQL_DUMP_PACKAGE_FAILED')
    } finally {
      await Promise.allSettled(staged.map(({ id }) => this.stagingStore.deleteJob(id)))
    }
  }

  async delete(jobId: string): Promise<void> {
    await this.outputWriter.delete(jobId)
  }

  private async *packageEntries(staged: StagedEntry[]) {
    for (const item of staged) {
      yield {
        ...item.entry,
        content: this.readStaged(item.id, item.chunks),
      }
    }
  }

  private async *readStaged(jobId: string, expectedChunks: number): AsyncIterable<Buffer> {
    const chunks = await this.stagingStore.list(jobId)
    if (chunks.length !== expectedChunks) throw new SqlDumpPackageWriterError('SQL_DUMP_PACKAGE_FAILED')
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index]?.index !== index) throw new SqlDumpPackageWriterError('SQL_DUMP_PACKAGE_FAILED')
      yield await this.stagingStore.read(jobId, index)
    }
  }
}
