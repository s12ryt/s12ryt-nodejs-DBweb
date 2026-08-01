import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'

import { AuthService } from './auth/auth-service.js'
import { MemorySessionCache } from './auth/cached-auth-repository.js'
import { KyselyAuthRepository } from './metadata/kysely-auth-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata/metadata-database.js'
import {
  buildRuntime,
  loadRuntimeConfig,
  RuntimeConfigError,
  type S3RuntimeClient,
} from './runtime.js'
import type { SshKnownHostService } from './ssh/ssh-known-host-service.js'
import type { SshTransportFactory } from './ssh/ssh-tunnel-pool.js'
import type { TransferCleanupService } from './transfers/transfer-cleanup-service.js'
import type { TransferAuditRecorder } from './transfers/transfer-audit.js'

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
    expect(loadRuntimeConfig(base).transferRoot).toBe(resolve('./data/transfers'))
    expect(loadRuntimeConfig({ ...base, DBWEB_TRANSFER_ROOT: './custom-transfers' }).transferRoot)
      .toBe(resolve('./custom-transfers'))
    expect(loadRuntimeConfig({ ...base, DBWEB_REDIS_URL: 'redis://cache.internal:6379' }).redisUrl)
      .toBe('redis://cache.internal:6379')
    expect(() => loadRuntimeConfig({ ...base, DBWEB_REDIS_URL: 'https://invalid.test' }))
      .toThrow(new RuntimeConfigError('INVALID_REDIS_URL'))
    expect(loadRuntimeConfig({
      ...base,
      DBWEB_METADATA_URL: 'postgres://dbweb:password@metadata:5432/dbweb',
      DBWEB_HA_INSTANCE_ID: 'api-1',
    }).haInstanceId).toBe('api-1')
    expect(() => loadRuntimeConfig({ ...base, DBWEB_HA_INSTANCE_ID: 'api-1' }))
      .toThrow(new RuntimeConfigError('INVALID_HA_INSTANCE'))
    expect(() => loadRuntimeConfig({
      ...base,
      DBWEB_METADATA_URL: 'postgres://dbweb:password@metadata:5432/dbweb',
      DBWEB_HA_INSTANCE_ID: 'invalid instance',
    })).toThrow(new RuntimeConfigError('INVALID_HA_INSTANCE'))
  })

  it('驗證S3/MinIO object storage設定且未配置時保留filesystem', () => {
    const base = {
      DBWEB_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
      DBWEB_ADMIN_PASSWORD: 'long-enough-password',
    }
    expect(loadRuntimeConfig(base).objectStorage).toEqual({
      kind: 'filesystem',
      root: resolve('./data/transfers'),
    })
    expect(loadRuntimeConfig({
      ...base,
      DBWEB_S3_BUCKET: 'dbweb-transfers',
      DBWEB_S3_REGION: 'us-east-1',
      DBWEB_S3_ENDPOINT: 'http://minio:9000',
      DBWEB_S3_FORCE_PATH_STYLE: 'true',
      DBWEB_S3_ACCESS_KEY_ID: 'dbweb-access',
      DBWEB_S3_SECRET_ACCESS_KEY: 'dbweb-secret',
      DBWEB_S3_SSE: 'AES256',
    }).objectStorage).toEqual({
      kind: 's3',
      bucket: 'dbweb-transfers',
      region: 'us-east-1',
      endpoint: 'http://minio:9000/',
      forcePathStyle: true,
      credentials: { accessKeyId: 'dbweb-access', secretAccessKey: 'dbweb-secret' },
      serverSideEncryption: 'AES256',
    })
    expect(() => loadRuntimeConfig({ ...base, DBWEB_S3_BUCKET: 'bucket' }))
      .toThrow(new RuntimeConfigError('INVALID_OBJECT_STORAGE'))
    expect(() => loadRuntimeConfig({
      ...base,
      DBWEB_S3_BUCKET: 'bucket',
      DBWEB_S3_REGION: 'us-east-1',
      DBWEB_S3_ACCESS_KEY_ID: 'only-access',
    })).toThrow(new RuntimeConfigError('INVALID_OBJECT_STORAGE'))
  })

  it('設定Redis時組裝PG權威session cache並在關閉時釋放client', async () => {
    const cache = new MemorySessionCache()
    const cacheSet = vi.spyOn(cache, 'set')
    const closeRedis = vi.fn(async () => undefined)
    let redisWakeListener: (() => void) | undefined
    const redisWake = vi.fn()
    const createRedisServices = vi.fn(async () => ({
      sessionCache: cache,
      transferWake: {
        close: vi.fn(async () => undefined),
        notify: vi.fn(async () => undefined),
        start: vi.fn(async (listener: () => void) => { redisWakeListener = listener }),
      },
      close: closeRedis,
    }))
    const workerStart = vi.fn()
    const workerStop = vi.fn(async () => undefined)
    const createTransferWorkerScheduler = vi.fn(() => ({
      start: workerStart,
      stop: workerStop,
      wake: redisWake,
    }))
    const app = await buildRuntime({
      host: '127.0.0.1',
      port: 3000,
      production: false,
      metadata: { kind: 'sqlite', filename: ':memory:' },
      redisUrl: 'redis://cache.internal:6379',
      masterKey: Buffer.alloc(32, 12),
      adminUsername: 'admin',
      adminPassword: 'bootstrap-admin-password',
    }, { createRedisServices, createTransferWorkerScheduler })

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'bootstrap-admin-password' },
    })
    await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: login.headers['set-cookie'] as string },
    })

    expect(createRedisServices).toHaveBeenCalledWith(
      'redis://cache.internal:6379',
      expect.anything(),
    )
    expect(createTransferWorkerScheduler).toHaveBeenCalledOnce()
    expect(workerStart).toHaveBeenCalledOnce()
    redisWakeListener?.()
    expect(redisWake).toHaveBeenCalledOnce()
    expect(cacheSet).toHaveBeenCalled()
    await app.close()
    expect(workerStop).toHaveBeenCalledOnce()
    expect(closeRedis).toHaveBeenCalledOnce()
  }, 20_000)

  it('S3模式以HeadBucket作readiness並在關閉時釋放client', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {}
      throw new Error('unexpected-s3-command')
    })
    const destroy = vi.fn()
    const createS3Client = vi.fn(() => ({ send, destroy } as S3RuntimeClient))
    const app = await buildRuntime({
      host: '127.0.0.1',
      port: 3000,
      production: false,
      metadata: { kind: 'sqlite', filename: ':memory:' },
      objectStorage: {
        kind: 's3',
        bucket: 'dbweb-transfers',
        region: 'us-east-1',
        endpoint: 'http://minio:9000/',
        forcePathStyle: true,
      },
      masterKey: Buffer.alloc(32, 14),
      adminUsername: 'admin',
      adminPassword: 'bootstrap-admin-password',
    }, { createS3Client })

    expect((await app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200)
    expect(createS3Client).toHaveBeenCalledWith(expect.objectContaining({
      region: 'us-east-1',
      endpoint: 'http://minio:9000/',
      forcePathStyle: true,
    }))
    expect(send).toHaveBeenCalledWith(expect.any(HeadBucketCommand))
    await app.close()
    expect(destroy).toHaveBeenCalledOnce()
  }, 20_000)

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
    const cleanupStart = vi.fn()
    const cleanupStop = vi.fn(async () => undefined)
    const transferAuditRecord = vi.fn(async () => undefined)
    const transferAuditRecorder: TransferAuditRecorder = { record: transferAuditRecord }
    const createTransferCleanupScheduler = vi.fn((service: TransferCleanupService) => {
      void service
      return { start: cleanupStart, stop: cleanupStop }
    })
    const app = await buildRuntime({
      host: '127.0.0.1',
      port: 3000,
      production: false,
      metadata: { kind: 'sqlite', filename: ':memory:' },
      masterKey: Buffer.alloc(32, 11),
      adminUsername: 'admin',
      adminPassword: 'bootstrap-admin-password',
    }, { createSshTransportFactory, createTransferCleanupScheduler, transferAuditRecorder })

    expect(createSshTransportFactory).toHaveBeenCalledOnce()
    expect(createSshTransportFactory.mock.calls[0]?.[0]).toBeDefined()
    expect(createTransferCleanupScheduler).toHaveBeenCalledOnce()
    expect(cleanupStart).toHaveBeenCalledOnce()
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
    expect((await app.inject({
      method: 'GET',
      url: '/api/transfers',
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'POST',
      url: '/api/transfers/11111111-1111-4111-8111-111111111111/preview',
      payload: { mapping: {}, strategy: {}, target: {} },
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'POST',
      url: '/api/transfers/11111111-1111-4111-8111-111111111111/execute',
      payload: { previewToken: 'v1.test.signature' },
    })).statusCode).toBe(401)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'bootstrap-admin-password' },
    })
    const session = login.json<{ csrfToken: string }>()
    const created = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: {
        cookie: login.headers['set-cookie'] as string,
        'x-csrf-token': session.csrfToken,
      },
      payload: { connectionId: 'c1', direction: 'export', format: 'csv' },
    })
    expect(created.statusCode).toBe(201)
    expect(transferAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      actorId: expect.any(String),
      connectionId: 'c1',
      action: 'job-create',
      status: 'success',
    }))
    await expect(app.close()).resolves.toBeUndefined()
    expect(cleanupStop).toHaveBeenCalledOnce()
  }, 20_000)
})
