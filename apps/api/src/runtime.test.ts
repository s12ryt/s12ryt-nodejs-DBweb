import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { AuthService } from './auth/auth-service.js'
import { KyselyAuthRepository } from './metadata/kysely-auth-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata/metadata-database.js'
import { buildRuntime, loadRuntimeConfig, RuntimeConfigError } from './runtime.js'
import type { SshKnownHostService } from './ssh/ssh-known-host-service.js'
import type { SshTransportFactory } from './ssh/ssh-tunnel-pool.js'

describe('runtime', () => {
  it('拒絕遺漏或長度錯誤的 master key，以及弱 bootstrap 密碼', () => {
    expect(() => loadRuntimeConfig({ DBWEB_ADMIN_PASSWORD: 'long-enough-password' })).toThrow(
      new RuntimeConfigError('INVALID_MASTER_KEY'),
    )
    expect(() =>
      loadRuntimeConfig({
        DBWEB_MASTER_KEY: Buffer.alloc(31).toString('base64'),
        DBWEB_ADMIN_PASSWORD: 'long-enough-password',
      }),
    ).toThrow(new RuntimeConfigError('INVALID_MASTER_KEY'))
    expect(() =>
      loadRuntimeConfig({
        DBWEB_MASTER_KEY: Buffer.alloc(32).toString('base64'),
        DBWEB_ADMIN_PASSWORD: 'short',
      }),
    ).toThrow(new RuntimeConfigError('INVALID_ADMIN_PASSWORD'))
  })

  it('正式環境預設供應 Web build，並允許容器覆寫產物路徑', () => {
    const base = {
      DBWEB_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
      DBWEB_ADMIN_PASSWORD: 'long-enough-password',
    }

    expect(loadRuntimeConfig(base).staticRoot).toBeUndefined()
    expect(loadRuntimeConfig({ ...base, NODE_ENV: 'production' }).staticRoot).toBe(
      resolve('apps/web/dist'),
    )
    expect(
      loadRuntimeConfig({ ...base, NODE_ENV: 'production', DBWEB_WEB_ROOT: './custom-web' })
        .staticRoot,
    ).toBe(resolve('./custom-web'))
  })

  it('組裝 SQLite runtime、bootstrap 管理員，重開後可登入且不重複建立', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-runtime-'))
    const filename = join(directory, 'data', 'metadata.sqlite')
    const config = loadRuntimeConfig({
      DBWEB_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      DBWEB_ADMIN_USERNAME: 'root',
      DBWEB_ADMIN_PASSWORD: 'correct horse battery staple',
      DBWEB_METADATA_FILE: filename,
      NODE_ENV: 'test',
    })

    const first = await buildRuntime(config)
    expect((await first.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    await first.close()

    const reopened = await buildRuntime(config)
    const login = await reopened.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'correct horse battery staple' },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json<{ user: { role: string } }>().user.role).toBe('admin')
    await reopened.close()
    await rm(directory, { recursive: true })
  }, 20_000)

  it('同名 bootstrap 帳號若已是一般使用者則拒絕啟動並回報角色衝突', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbweb-runtime-conflict-'))
    const filename = join(directory, 'metadata.sqlite')
    const database = createMetadataDatabase({ kind: 'sqlite', filename })
    await migrateMetadata(database)
    const auth = new AuthService(new KyselyAuthRepository(database), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 1024, timeCost: 1 },
    })
    await auth.createUser({
      username: 'root',
      password: 'existing-user-password',
      role: 'user',
    })
    await database.destroy()

    try {
      await expect(
        buildRuntime({
          host: '127.0.0.1',
          port: 3000,
          production: false,
          metadata: { kind: 'sqlite', filename },
          masterKey: Buffer.alloc(32, 9),
          adminUsername: 'root',
          adminPassword: 'bootstrap-admin-password',
        }),
      ).rejects.toThrow(new RuntimeConfigError('BOOTSTRAP_ADMIN_CONFLICT'))
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('組裝共享 SSH 基礎設施並可安全關閉未使用的 pool', async () => {
    const transportFactory: SshTransportFactory = { connect: vi.fn() }
    const createSshTransportFactory = vi.fn((knownHosts: SshKnownHostService) => {
      void knownHosts
      return transportFactory
    })
    const app = await buildRuntime({
      host: '127.0.0.1',
      port: 3000,
      production: false,
      metadata: { kind: 'sqlite', filename: ':memory:' },
      masterKey: Buffer.alloc(32, 11),
      adminUsername: 'admin',
      adminPassword: 'bootstrap-admin-password',
    }, { createSshTransportFactory })

    expect(createSshTransportFactory).toHaveBeenCalledOnce()
    expect(createSshTransportFactory.mock.calls[0]?.[0]).toBeDefined()
    expect((await app.inject({
      method: 'GET',
      url: '/api/connections/c1/schemas/public/tables/orders/mutations',
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: '/api/connections/c1/ddl/capabilities',
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: '/api/connections/c1/accounts',
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: '/api/connections/c1/accounts/grants?targetDatabase=app&engine=postgres&username=reader',
    })).statusCode).toBe(401)
    await expect(app.close()).resolves.toBeUndefined()
  }, 20_000)
})
