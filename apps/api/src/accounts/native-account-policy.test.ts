import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import {
  NativeAccountPolicyError,
  identityKey,
  isProtectedNativeAccount,
  normalizeNativeAccountIdentity,
} from './native-account-policy.js'

const postgresConnection: ResolvedConnection = {
  id: 'connection-1',
  name: 'PostgreSQL',
  engine: 'postgres',
  host: 'database.test',
  port: 5432,
  database: 'app',
  username: 'dbweb_runtime',
  password: 'database-secret',
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

describe('native account policy', () => {
  it('normalizes PostgreSQL roles and MySQL user-host identities without collisions', () => {
    expect(normalizeNativeAccountIdentity('postgres', { username: ' app_user ' })).toEqual({
      engine: 'postgres',
      username: 'app_user',
    })
    expect(normalizeNativeAccountIdentity('mysql', { username: 'app' })).toEqual({
      engine: 'mysql',
      username: 'app',
      host: '%',
    })
    expect(identityKey({ engine: 'mysql', username: 'a@b', host: '%' })).not.toBe(
      identityKey({ engine: 'mysql', username: 'a', host: 'b@%' }),
    )
  })

  it('allows safe MySQL host patterns and rejects control or injection characters', () => {
    expect(
      normalizeNativeAccountIdentity('mysql', { username: 'reporter', host: '10.20._.%' }),
    ).toMatchObject({ host: '10.20._.%' })
    expect(
      normalizeNativeAccountIdentity('mysql', { username: 'reporter', host: '2001:db8::1' }),
    ).toMatchObject({ host: '2001:db8::1' })

    for (const host of ['db.example.test\nattacker', "%' OR 1=1 --", '']) {
      expect(() => normalizeNativeAccountIdentity('mysql', { username: 'reporter', host })).toThrow(
        new NativeAccountPolicyError('INVALID_ACCOUNT_IDENTITY'),
      )
    }
  })

  it('protects the active connection identity and database system accounts', () => {
    expect(
      isProtectedNativeAccount(
        { identity: { engine: 'postgres', username: 'dbweb_runtime' }, systemAccount: false },
        postgresConnection,
      ),
    ).toEqual({ protected: true, reason: 'connection-account' })
    expect(
      isProtectedNativeAccount(
        { identity: { engine: 'postgres', username: 'postgres' }, systemAccount: true },
        postgresConnection,
      ),
    ).toEqual({ protected: true, reason: 'system-account' })
    expect(
      isProtectedNativeAccount(
        { identity: { engine: 'postgres', username: 'app_user' }, systemAccount: false },
        postgresConnection,
      ),
    ).toEqual({ protected: false })
  })
})
