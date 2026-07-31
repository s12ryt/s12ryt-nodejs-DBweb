import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionProfile, ResolvedConnection } from '../connections/connection-types.js'
import type { SqlGateway } from '../query/sql-query-service.js'
import {
  KeepAliveScheduler,
  MemoryKeepAliveRecorder,
  SqlKeepAliveService,
} from './sql-keepalive-service.js'

const enabledProfile = (id: string, intervalMs = 60_000): ConnectionProfile => ({
  id,
  name: id,
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'app',
  username: 'dbweb',
  tls: { mode: 'disable', hasCa: false, hasClientCertificate: false },
  keepAlive: { enabled: true, intervalMs },
  createdBy: 'admin-1',
  createdAt: '2026-07-31T00:00:00.000Z',
})

const resolvedProfile = (profile: ConnectionProfile): ResolvedConnection => ({
  id: profile.id,
  name: profile.name,
  engine: profile.engine,
  host: profile.host,
  port: profile.port,
  database: profile.database,
  username: profile.username,
  password: 'secret',
  tls: { mode: profile.tls.mode },
  keepAlive: profile.keepAlive,
})

describe('SqlKeepAliveService', () => {
  afterEach(() => vi.useRealTimers())

  it('略過停用連線，並在啟用連線到達各自間隔後執行固定 SELECT 1', async () => {
    let now = 1_000
    const enabled = enabledProfile('enabled')
    const disabled = {
      ...enabledProfile('disabled'),
      keepAlive: { enabled: false, intervalMs: 60_000 },
    }
    const execute = vi.fn<SqlGateway['execute']>().mockResolvedValue({
      columns: ['result'],
      rows: [{ result: 1 }],
      affectedRows: 0,
    })
    const recorder = new MemoryKeepAliveRecorder()
    const service = new SqlKeepAliveService(
      {
        list: async () => [enabled, disabled],
        resolveConnection: async (id) => resolvedProfile(id === enabled.id ? enabled : disabled),
      },
      { postgres: { execute }, mysql: { execute } },
      recorder,
      { now: () => now },
    )

    await service.tick()
    expect(execute).not.toHaveBeenCalled()

    now += 59_999
    await service.tick()
    expect(execute).not.toHaveBeenCalled()

    now += 1
    await service.tick()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'enabled' }),
      expect.objectContaining({ sql: 'SELECT 1', timeoutMs: 10_000, maxRows: 1 }),
    )
    expect(await recorder.list()).toEqual([
      expect.objectContaining({ connectionId: 'enabled', status: 'success' }),
    ])
  })

  it('分別記錄探測失敗與逾時，且不向外拋出以免中止其他連線', async () => {
    vi.useFakeTimers()
    const failed = enabledProfile('failed')
    const timedOut = enabledProfile('timed-out')
    const recorder = new MemoryKeepAliveRecorder()
    const execute = vi.fn<SqlGateway['execute']>().mockImplementation((_connection, request) => {
      if (_connection.id === failed.id) return Promise.reject(new Error('driver detail'))
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    })
    let now = 0
    const service = new SqlKeepAliveService(
      {
        list: async () => [failed, timedOut],
        resolveConnection: async (id) => resolvedProfile(id === failed.id ? failed : timedOut),
      },
      { postgres: { execute }, mysql: { execute } },
      recorder,
      { now: () => now, timeoutMs: 10_000 },
    )

    await service.tick()
    now = 60_000
    const tick = service.tick()
    await vi.advanceTimersByTimeAsync(10_000)
    await tick

    expect(await recorder.list()).toEqual([
      expect.objectContaining({ connectionId: 'failed', status: 'failed' }),
      expect.objectContaining({ connectionId: 'timed-out', status: 'timeout' }),
    ])
  })
})

describe('KeepAliveScheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('啟動後定期 tick，停止後不再執行且不重疊尚未完成的 tick', async () => {
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    const tick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const scheduler = new KeepAliveScheduler({ tick }, 30_000)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledOnce()

    finish?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tick).toHaveBeenCalledTimes(2)

    const stopped = scheduler.stop()
    let stopCompleted = false
    void stopped.then(() => { stopCompleted = true })
    await Promise.resolve()
    expect(stopCompleted).toBe(false)

    finish?.()
    await stopped
    expect(stopCompleted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
