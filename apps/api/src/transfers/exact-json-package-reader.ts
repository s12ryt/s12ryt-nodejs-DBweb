import type { ExactJsonManifest, ExactJsonRecord } from './exact-json-format.js'
import { decodeExactJson } from './exact-json-format.js'
import { readSafeTar } from './safe-tar.js'

export type ExactJsonPackageErrorCode = 'INVALID_EXACT_JSON_PACKAGE'

export class ExactJsonPackageError extends Error {
  constructor(readonly code: ExactJsonPackageErrorCode) {
    super(code)
    this.name = 'ExactJsonPackageError'
  }
}

export async function readExactJsonPackage<T>(
  chunks: AsyncIterable<Uint8Array>,
  handler: (
    manifest: ExactJsonManifest,
    records: AsyncIterable<ExactJsonRecord>,
  ) => Promise<T>,
  options: { compression?: 'none' | 'gzip' } = {},
): Promise<T> {
  let entries = 0
  let handled = false
  let result: T | undefined
  let handlerError: unknown
  try {
    await readSafeTar(chunks, async (entry, content) => {
      entries += 1
      if (entry.path !== 'data.ndjson' || entries !== 1) invalidPackage()
      const decoded = await decodeExactJson(content)
      try {
        result = await handler(decoded.manifest, decoded.records)
      } catch (error) {
        handlerError = error
        throw error
      }
      handled = true
    }, { compression: options.compression ?? 'none' })
    if (entries !== 1 || !handled) invalidPackage()
    return result as T
  } catch (error) {
    if (handlerError !== undefined) throw handlerError
    if (error instanceof ExactJsonPackageError) throw error
    throw new ExactJsonPackageError('INVALID_EXACT_JSON_PACKAGE')
  }
}

function invalidPackage(): never {
  throw new ExactJsonPackageError('INVALID_EXACT_JSON_PACKAGE')
}
