import { describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import type { ResolvedConnection } from '../connections/connection-types.js'
import type { SecurityAuditEvent } from '../security/security-audit.js'
import { DatabaseOperationGateError } from '../ha/database-operation-gate.js'
import type { ActualNativeAccount } from './native-account-service.js'
import { NativeGrantGatewayError, type NativeGrantGateway } from './native-grant-gateway.js'
import {
  NativeGrantService,
  NativeGrantServiceError,
} from './native-grant-service.js'

const admin: AuthUser = {
  id: 'admin-1', username: 'admin', role: 'admin', enabled: true, passwordChangeRequired: false,
}
const manager: AuthUser = {
  id: 'manager-1', username: 'manager', role: 'user', enabled: true, passwordChangeRequired: false,
}
const connection: ResolvedConnection = {
  id: 'c1', name: 'Database', engine: 'postgres', host: 'db.internal', port: 5432,
  database: 'app', username: 'dbweb_runtime', password: 'database-secret',
  tls: { mode: 'disable' }, keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}
const reader: ActualNativeAccount = {
  identity: { engine: 'postgres', username: 'reader' },
  canLogin: true, passwordExpired: false, connectionLimit: -1, systemAccount: false,
}

function setup(options: {
  authorized?: boolean
  accounts?: ActualNativeAccount[]
  execute?: NativeGrantGateway['execute']
} = {}) {
  const resolveConnection = vi.fn(async () => connection)
  const listAccounts = vi.fn(async () => options.accounts ?? [reader])
  const listGrants = vi.fn(async () => [{
    scope: 'database' as const, database: 'analytics', privileges: ['connect' as const],
  }])
  const execute = vi.fn(options.execute ?? (async (_connection, _database, statements) => ({
    appliedCount: statements.length,
  })))
  const audits: SecurityAuditEvent[] = []
  const service = new NativeGrantService(
    { resolveConnection },
    { postgres: { listAccounts }, mysql: { listAccounts } },
    {
      postgres: { listGrants, execute },
      mysql: { listGrants, execute },
    },
    async () => options.authorized ?? true,
    { record: async (event) => { audits.push(structuredClone(event)) } },
  )
  return { service, resolveConnection, listAccounts, listGrants, execute, audits }
}

describe('NativeGrantService', () => {
  it('checks account-manage before resolving a connection', async () => {
    const { service, resolveConnection } = setup({ authorized: false })

    await expect(service.list(manager, 'c1', 'analytics', reader.identity))
      .rejects.toEqual(new NativeGrantServiceError('FORBIDDEN'))
    expect(resolveConnection).not.toHaveBeenCalled()
  })

  it('lists actual grants for existing accounts, including protected accounts', async () => {
    const protectedAccount: ActualNativeAccount = {
      ...reader,
      identity: { engine: 'postgres', username: 'dbweb_runtime' },
    }
    const { service, listGrants } = setup({ accounts: [protectedAccount] })

    await expect(service.list(admin, 'c1', 'analytics', protectedAccount.identity)).resolves.toEqual([
      { scope: 'database', database: 'analytics', privileges: ['connect'] },
    ])
    expect(listGrants).toHaveBeenCalledWith(connection, 'analytics', protectedAccount.identity)
  })

  it('rejects changes to missing and protected accounts before grant execution', async () => {
    const missing = setup({ accounts: [] })
    await expect(missing.service.execute(admin, 'c1', {
      kind: 'grant', identity: reader.identity,
      changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
    })).rejects.toEqual(new NativeGrantServiceError('ACCOUNT_NOT_FOUND'))
    expect(missing.execute).not.toHaveBeenCalled()

    const protectedAccount: ActualNativeAccount = {
      ...reader,
      identity: { engine: 'postgres', username: 'dbweb_runtime' },
    }
    const protectedSetup = setup({ accounts: [protectedAccount] })
    await expect(protectedSetup.service.execute(admin, 'c1', {
      kind: 'grant', identity: protectedAccount.identity,
      changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
    })).rejects.toEqual(new NativeGrantServiceError('PROTECTED_ACCOUNT'))
    expect(protectedSetup.execute).not.toHaveBeenCalled()
  })

  it('executes PostgreSQL changes atomically and records encrypted-detail inputs without secrets', async () => {
    const { service, execute, audits } = setup()
    const command = {
      kind: 'grant' as const,
      identity: reader.identity,
      changes: [
        { scope: 'database' as const, database: 'analytics', privileges: ['connect' as const] },
        { scope: 'schema' as const, database: 'analytics', schema: 'reporting', privileges: ['usage' as const] },
      ],
    }

    await expect(service.execute(admin, 'c1', command)).resolves.toEqual({ appliedCount: 2 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[2]).toHaveLength(2)
    expect(audits).toEqual([expect.objectContaining({
      actorId: 'admin-1', connectionId: 'c1', action: 'native-grant', status: 'success',
      details: expect.objectContaining({
        nativeIdentity: '["postgres","reader"]', targetDatabase: 'analytics',
        appliedCount: 2, sqlTemplates: expect.arrayContaining([expect.stringContaining('GRANT CONNECT')]),
      }),
    })])
    expect(JSON.stringify(audits)).not.toContain('database-secret')
  })

  it('保留可重試的資料庫操作忙碌錯誤', async () => {
    const busy = new DatabaseOperationGateError('DATABASE_OPERATION_BUSY', true)
    const { service } = setup({ execute: async () => { throw busy } })

    await expect(service.execute(admin, 'c1', {
      kind: 'grant', identity: reader.identity,
      changes: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }],
    })).rejects.toBe(busy)
  })

  it('audits each MySQL step and reports partial progress without compensating', async () => {
    const mysqlConnection: ResolvedConnection = {
      ...connection, engine: 'mysql', port: 3306, username: 'dbweb_mysql',
    }
    const mysqlReader: ActualNativeAccount = {
      ...reader, identity: { engine: 'mysql', username: 'reader', host: '%' },
    }
    const resolveConnection = vi.fn(async () => mysqlConnection)
    const execute = vi.fn(async (_connection, _database, statements: string[]) => {
      if (statements[0]!.includes('blocked')) {
        throw new NativeGrantGatewayError('NATIVE_GRANT_FAILED', 0, 0)
      }
      return { appliedCount: 1 }
    })
    const audits: SecurityAuditEvent[] = []
    const service = new NativeGrantService(
      { resolveConnection },
      { postgres: { listAccounts: async () => [] }, mysql: { listAccounts: async () => [mysqlReader] } },
      {
        postgres: { listGrants: async () => [], execute },
        mysql: { listGrants: async () => [], execute },
      },
      async () => true,
      { record: async (event) => { audits.push(structuredClone(event)) } },
    )

    await expect(service.execute(manager, 'c1', {
      kind: 'revoke', identity: mysqlReader.identity, confirmed: true,
      changes: [
        { scope: 'table', database: 'app', table: 'orders', privileges: ['select'] },
        { scope: 'table', database: 'app', table: 'blocked', privileges: ['select'] },
        { scope: 'table', database: 'app', table: 'never_run', privileges: ['select'] },
      ],
    })).rejects.toEqual(new NativeGrantServiceError('NATIVE_GRANT_FAILED', 1, 1))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(audits.map(({ status, details }) => ({ status, appliedCount: details?.appliedCount })))
      .toEqual([
        { status: 'success', appliedCount: 1 },
        { status: 'failed', appliedCount: 1 },
      ])
  })
})
