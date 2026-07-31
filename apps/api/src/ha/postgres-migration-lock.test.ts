import { describe, expect, it, vi } from 'vitest'

import {
  PostgresMigrationLock,
  type PostgresMigrationLockSession,
} from './postgres-migration-lock.js'

describe('PostgresMigrationLock', () => {
  it('在同一session取得advisory lock後執行migration並保證解鎖', async () => {
    const calls: string[] = []
    const session: PostgresMigrationLockSession = {
      lock: vi.fn(async () => { calls.push('lock') }),
      unlock: vi.fn(async () => { calls.push('unlock') }),
    }
    const withSession = vi.fn(async (run: (value: PostgresMigrationLockSession) => Promise<void>) => {
      calls.push('session')
      await run(session)
    })
    const migration = vi.fn(async () => { calls.push('migration') })

    await new PostgresMigrationLock({ withSession }).run(migration)

    expect(calls).toEqual(['session', 'lock', 'migration', 'unlock'])
    expect(session.lock).toHaveBeenCalledWith('dbweb-metadata-migration-v1')
    expect(session.unlock).toHaveBeenCalledWith('dbweb-metadata-migration-v1')
  })

  it('migration失敗仍解鎖，且解鎖錯誤不覆蓋原始失敗', async () => {
    const migrationError = new Error('migration-failed')
    const session: PostgresMigrationLockSession = {
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => { throw new Error('unlock-failed') }),
    }
    const lock = new PostgresMigrationLock({
      withSession: async (run) => run(session),
    })

    await expect(lock.run(async () => { throw migrationError })).rejects.toBe(migrationError)
    expect(session.unlock).toHaveBeenCalledOnce()
  })
})
