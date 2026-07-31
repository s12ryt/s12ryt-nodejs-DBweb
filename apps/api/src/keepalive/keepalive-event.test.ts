import { describe, expect, it } from 'vitest'

import { RetainedKeepAliveRecorder } from './keepalive-event.js'

describe('RetainedKeepAliveRecorder', () => {
  it('將保活結果保存 90 天且不加入 SQL 或底層錯誤內容', async () => {
    const entries: unknown[] = []
    const recorder = new RetainedKeepAliveRecorder(
      { create: async (entry) => void entries.push(entry), deleteExpired: async () => 0 },
      () => new Date('2026-07-31T00:00:00.000Z'),
    )

    await recorder.record({
      connectionId: 'connection-1',
      status: 'failed',
      durationMs: 125,
      createdAt: '2026-07-31T00:00:00.000Z',
    })

    expect(entries).toEqual([
      {
        id: expect.any(String),
        connectionId: 'connection-1',
        status: 'failed',
        durationMs: 125,
        createdAt: '2026-07-31T00:00:00.000Z',
        expiresAt: '2026-10-29T00:00:00.000Z',
      },
    ])
  })
})
