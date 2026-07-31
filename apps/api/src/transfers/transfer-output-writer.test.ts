import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  TransferOutputError,
  TransferOutputWriter,
} from './transfer-output-writer.js'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

describe('TransferOutputWriter', () => {
  it('writes fixed-size encrypted chunks while computing the whole-file checksum', async () => {
    const stored: Array<{ index: number; bytes: Buffer; checksum: string }> = []
    const store = {
      deleteJob: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_jobId: string, index: number, bytes: Uint8Array, checksum: string) => {
        stored.push({ index, bytes: Buffer.from(bytes), checksum })
        return { index, size: bytes.byteLength, checksum }
      }),
    }
    const writer = new TransferOutputWriter(store, 5)
    const content = Buffer.from('abcdefghijkl')

    const result = await writer.write(JOB_ID, (async function* () {
      yield content.subarray(0, 2)
      yield content.subarray(2, 9)
      yield content.subarray(9)
    })())

    expect(stored.map((chunk) => [chunk.index, chunk.bytes.toString()])).toEqual([
      [0, 'abcde'],
      [1, 'fghij'],
      [2, 'kl'],
    ])
    expect(stored.every((chunk) => chunk.checksum === createHash('sha256').update(chunk.bytes).digest('hex'))).toBe(true)
    expect(result).toEqual({
      bytes: 12,
      chunks: 3,
      checksum: createHash('sha256').update(content).digest('hex'),
    })
    expect(store.deleteJob).toHaveBeenCalledTimes(1)
  })

  it('writes an empty output as one verifiable chunk', async () => {
    const store = {
      deleteJob: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue({ index: 0, size: 0, checksum: createHash('sha256').digest('hex') }),
    }
    const writer = new TransferOutputWriter(store, 5)

    const result = await writer.write(JOB_ID, (async function* () {})())

    expect(store.put).toHaveBeenCalledWith(JOB_ID, 0, Buffer.alloc(0), createHash('sha256').digest('hex'))
    expect(result.bytes).toBe(0)
    expect(result.chunks).toBe(1)
  })

  it('removes all partial chunks when writing fails or is cancelled', async () => {
    const store = {
      deleteJob: vi.fn().mockResolvedValue(undefined),
      put: vi.fn()
        .mockResolvedValueOnce({ index: 0, size: 5, checksum: 'a'.repeat(64) })
        .mockRejectedValueOnce(new Error('storage-secret')),
    }
    const writer = new TransferOutputWriter(store, 5)

    await expect(writer.write(JOB_ID, (async function* () {
      yield Buffer.from('abcdefghij')
    })())).rejects.toEqual(new TransferOutputError('TRANSFER_OUTPUT_FAILED'))
    expect(store.deleteJob).toHaveBeenCalledTimes(2)

    const controller = new AbortController()
    controller.abort()
    await expect(writer.write(JOB_ID, (async function* () {
      yield Buffer.from('ignored')
    })(), controller.signal)).rejects.toEqual(new TransferOutputError('TRANSFER_OUTPUT_CANCELLED'))
    expect(store.deleteJob).toHaveBeenCalledTimes(4)
  })

  it('exposes explicit cleanup for orchestration failures after writing', async () => {
    const store = {
      deleteJob: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(),
    }
    const writer = new TransferOutputWriter(store, 5)

    await writer.delete(JOB_ID)

    expect(store.deleteJob).toHaveBeenCalledWith(JOB_ID)
  })
})
