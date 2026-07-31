import { sha256 } from '@noble/hashes/sha2.js'

import type { Locale, TransferJob } from './api.js'

const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024

interface UploadedChunk {
  index: number
  size: number
  checksum: string
}

export interface UploadTransferFileOptions {
  jobId: string
  file: Blob
  csrfToken: string
  locale: Locale
  chunkSizeBytes?: number
  fetcher?: typeof fetch
  onProgress?: (uploadedBytes: number) => void
}

export async function uploadTransferFile(options: UploadTransferFileOptions): Promise<TransferJob> {
  const chunkSize = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('INVALID_CHUNK_SIZE')
  const fetcher = options.fetcher ?? fetch
  const base = `/api/transfers/${encodeURIComponent(options.jobId)}`
  const existingResponse = await fetcher(`${base}/chunks`, requestOptions(options, 'GET'))
  const existing = await readJson<UploadedChunk[]>(existingResponse)
  const existingByIndex = new Map(existing.map((chunk) => [chunk.index, chunk]))
  const wholeHash = sha256.create()
  let uploadedBytes = 0

  for (let index = 0, offset = 0; offset < options.file.size; index += 1, offset += chunkSize) {
    const chunk = await blobBytes(options.file.slice(offset, offset + chunkSize))
    wholeHash.update(chunk)
    const checksum = toHex(sha256(chunk))
    const resumed = existingByIndex.get(index)
    if (resumed) {
      if (resumed.size !== chunk.byteLength || resumed.checksum !== checksum) {
        throw new Error('UPLOAD_CHUNK_CONFLICT')
      }
    } else {
      const response = await fetcher(`${base}/chunks/${index}`, {
        ...requestOptions(options, 'PUT'),
        headers: {
          ...requestHeaders(options),
          'content-type': 'application/octet-stream',
          'x-chunk-sha256': checksum,
        },
        body: chunk,
      })
      await readJson<UploadedChunk>(response)
    }
    uploadedBytes += chunk.byteLength
    options.onProgress?.(uploadedBytes)
  }

  const response = await fetcher(`${base}/upload-complete`, {
    ...requestOptions(options, 'POST'),
    headers: { ...requestHeaders(options), 'content-type': 'application/json' },
    body: JSON.stringify({ expectedBytes: options.file.size, expectedChecksum: toHex(wholeHash.digest()) }),
  })
  return readJson<TransferJob>(response)
}

function requestHeaders(options: UploadTransferFileOptions): Record<string, string> {
  return { 'accept-language': options.locale, 'x-csrf-token': options.csrfToken }
}

function requestOptions(options: UploadTransferFileOptions, method: string): RequestInit {
  return { method, credentials: 'include', headers: requestHeaders(options) }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined
    throw new Error(payload?.error?.code ?? payload?.error?.message ?? `HTTP_${response.status}`)
  }
  return response.json() as Promise<T>
}

function toHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_FAILED'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(blob)
  })
}
