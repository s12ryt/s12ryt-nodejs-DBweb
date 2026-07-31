import { describe, expect, it, vi } from 'vitest'

import { uploadTransferFile } from './transfer-upload-client.js'

const firstChecksum = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'
const secondChecksum = 'c42522128b49193de8cd45d8f7589cd7e085e65f138640d57d4482e5f7189623'
const fileChecksum = '7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89'

describe('uploadTransferFile', () => {
  it('resumes matching chunks and completes with an incrementally computed file checksum', async () => {
    const content = Uint8Array.from([1, 2, 3, 4, 5, 6])
    const first = content.subarray(0, 4)
    const second = content.subarray(4)
    const requests: Array<{ url: string; method: string; body?: Uint8Array; headers: Headers }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const headers = new Headers(init?.headers)
      const body = init?.body instanceof Uint8Array
        ? init.body
        : typeof init?.body === 'string' ? new TextEncoder().encode(init.body) : undefined
      requests.push({ url, method, ...(body ? { body } : {}), headers })
      if (method === 'GET') {
        return Response.json([{ index: 0, size: first.byteLength, checksum: firstChecksum }])
      }
      if (method === 'PUT') {
        return Response.json({ index: 1, size: second.byteLength, checksum: secondChecksum })
      }
      return Response.json({ id: 'job-id', status: 'queued' })
    })
    const progress: number[] = []

    await uploadTransferFile({
      jobId: '11111111-1111-4111-8111-111111111111',
      file: new Blob([content]),
      csrfToken: 'csrf-token',
      locale: 'zh-TW',
      chunkSizeBytes: 4,
      fetcher,
      onProgress: (uploadedBytes: number) => progress.push(uploadedBytes),
    })

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: '/api/transfers/11111111-1111-4111-8111-111111111111/chunks' },
      { method: 'PUT', url: '/api/transfers/11111111-1111-4111-8111-111111111111/chunks/1' },
      { method: 'POST', url: '/api/transfers/11111111-1111-4111-8111-111111111111/upload-complete' },
    ])
    expect(requests[1]?.body).toEqual(second)
    expect(requests[1]?.headers.get('x-chunk-sha256')).toBe(secondChecksum)
    expect(requests[1]?.headers.get('x-csrf-token')).toBe('csrf-token')
    expect(JSON.parse(new TextDecoder().decode(requests[2]?.body))).toEqual({
      expectedBytes: content.byteLength,
      expectedChecksum: fileChecksum,
    })
    expect(progress).toEqual([4, 6])
  })

  it('fails before completion when a resumed chunk does not match the selected file', async () => {
    const fetcher = vi.fn(async () => Response.json([{ index: 0, size: 4, checksum: '0'.repeat(64) }]))

    await expect(uploadTransferFile({
      jobId: '11111111-1111-4111-8111-111111111111',
      file: new Blob([Uint8Array.from([1, 2, 3, 4])]),
      csrfToken: 'csrf-token',
      locale: 'en',
      chunkSizeBytes: 4,
      fetcher,
    })).rejects.toThrow('UPLOAD_CHUNK_CONFLICT')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
