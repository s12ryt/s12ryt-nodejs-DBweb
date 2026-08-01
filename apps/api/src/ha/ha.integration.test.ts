import { createHash, randomBytes } from 'node:crypto'

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CachedAuthRepository } from '../auth/cached-auth-repository.js'
import type { StoredSession, StoredUser } from '../auth/auth-types.js'
import { KyselyAuthRepository } from '../metadata/kysely-auth-repository.js'
import { KyselyDatabaseOperationLeaseRepository } from '../metadata/kysely-database-operation-lease-repository.js'
import { KyselyTransferJobRepository } from '../metadata/kysely-transfer-job-repository.js'
import { KyselyTransferWorkerLeaseRepository } from '../metadata/kysely-transfer-worker-lease-repository.js'
import { createMetadataDatabase, migrateMetadata, type MetadataKysely } from '../metadata/metadata-database.js'
import { buildRuntime } from '../runtime.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { S3EncryptedChunkStore } from '../transfers/s3-encrypted-chunk-store.js'
import type { StoredTransferJob } from '../transfers/transfer-job.js'
import { TransferWorkerLeaseService } from '../transfers/transfer-worker-lease.js'
import { PostgresMigrationLock, KyselyPostgresMigrationSessionProvider } from './postgres-migration-lock.js'
import { RedisFallbackCircuit } from './redis-fallback-circuit.js'
import { createRedisRuntimeServices, type RedisRuntimeServices } from './redis-runtime.js'
import { DatabaseOperationLeaseService, type DatabaseOperationLease } from './database-operation-gate.js'

const enabled = process.env.DBWEB_HA_INTEGRATION === '1'
const describeHa = enabled ? describe : describe.skip
const postgresUrl = process.env.DBWEB_HA_POSTGRES_URL ?? 'postgres://dbweb:dbweb-test-password@127.0.0.1:5432/dbweb'
const redisUrl = process.env.DBWEB_HA_REDIS_URL ?? 'redis://127.0.0.1:6379'
const s3Endpoint = process.env.DBWEB_HA_S3_ENDPOINT ?? 'http://127.0.0.1:9000'
const s3Bucket = process.env.DBWEB_HA_S3_BUCKET ?? 'dbweb-ha-integration'
const s3AccessKeyId = process.env.DBWEB_HA_S3_ACCESS_KEY_ID ?? 'dbweb-minio'
const s3SecretAccessKey = process.env.DBWEB_HA_S3_SECRET_ACCESS_KEY ?? 'dbweb-minio-secret'

describeHa('PostgreSQL, Redis, and MinIO HA integration', () => {
  let firstDatabase: MetadataKysely
  let secondDatabase: MetadataKysely
  let firstRedis: RedisRuntimeServices
  let secondRedis: RedisRuntimeServices
  let redisClosed = false
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
  })

  beforeAll(async () => {
    firstDatabase = createMetadataDatabase({ kind: 'postgres', connectionString: postgresUrl, maxConnections: 5 })
    secondDatabase = createMetadataDatabase({ kind: 'postgres', connectionString: postgresUrl, maxConnections: 5 })
    await Promise.all([
      new PostgresMigrationLock(new KyselyPostgresMigrationSessionProvider(firstDatabase))
        .run(() => migrateMetadata(firstDatabase)),
      new PostgresMigrationLock(new KyselyPostgresMigrationSessionProvider(secondDatabase))
        .run(() => migrateMetadata(secondDatabase)),
    ])
    firstRedis = await createRedisRuntimeServices(redisUrl, new RedisFallbackCircuit({ failureThreshold: 1 }))
    secondRedis = await createRedisRuntimeServices(redisUrl, new RedisFallbackCircuit({ failureThreshold: 1 }))
    await s3.send(new CreateBucketCommand({ Bucket: s3Bucket })).catch((error: unknown) => {
      if (!(error instanceof Error) || (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists')) {
        throw error
      }
    })
  }, 30_000)

  afterAll(async () => {
    if (!redisClosed) await Promise.all([firstRedis.close(), secondRedis.close()])
    await Promise.all([firstDatabase.destroy(), secondDatabase.destroy()])
    s3.destroy()
  })

  it('runs two active API runtimes and promotes the standby within thirty seconds', async () => {
    const masterKey = Buffer.alloc(32, 41)
    const instancePrefix = `ha-${Date.now()}`
    const apps: Array<FastifyInstance | undefined> = []
    for (let index = 1; index <= 3; index += 1) {
      apps.push(await buildRuntime({
        host: '127.0.0.1',
        port: 3000 + index,
        production: false,
        metadata: { kind: 'postgres', connectionString: postgresUrl, maxConnections: 5 },
        redisUrl,
        haInstanceId: `${instancePrefix}-${index}`,
        objectStorage: {
          kind: 's3',
          bucket: s3Bucket,
          region: 'us-east-1',
          endpoint: s3Endpoint,
          forcePathStyle: true,
          credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
        },
        masterKey,
        adminUsername: 'ha-runtime-admin',
        adminPassword: 'ha-runtime-admin-password',
      }))
    }

    try {
      const health = await Promise.all(apps.map(async (app) => (
        app!.inject({ method: 'GET', url: '/api/health' })
      )))
      const activeIndexes = health.flatMap((response, index) => (
        response.json<{ role: string }>().role === 'active' ? [index] : []
      ))
      const standbyIndex = health.findIndex((response) => (
        response.json<{ role: string }>().role === 'standby'
      ))
      expect(activeIndexes).toHaveLength(2)
      expect(standbyIndex).toBeGreaterThanOrEqual(0)
      expect(health[standbyIndex]?.statusCode).toBe(200)
      await expect(apps[standbyIndex]!.inject({ method: 'GET', url: '/api/health/ready' }))
        .resolves.toMatchObject({ statusCode: 503 })

      const login = await apps[activeIndexes[0]!]!.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'ha-runtime-admin', password: 'ha-runtime-admin-password' },
      })
      expect(login.statusCode).toBe(200)
      const cookie = login.headers['set-cookie'] as string
      await expect(apps[activeIndexes[1]!]!.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      })).resolves.toMatchObject({ statusCode: 200 })

      const closedIndex = activeIndexes[0]!
      await apps[closedIndex]!.close()
      apps[closedIndex] = undefined
      const deadline = Date.now() + 30_000
      let promoted = false
      while (Date.now() < deadline) {
        const response = await apps[standbyIndex]!.inject({ method: 'GET', url: '/api/health/ready' })
        if (response.statusCode === 200) {
          promoted = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(promoted).toBe(true)
    } finally {
      await Promise.all(apps.flatMap((app) => app ? [app.close()] : []))
    }
  }, 60_000)

  it('serializes migrations and shares sessions with immediate PostgreSQL-authoritative revocation', async () => {
    let active = 0
    let maximumActive = 0
    const firstLock = new PostgresMigrationLock(new KyselyPostgresMigrationSessionProvider(firstDatabase))
    const secondLock = new PostgresMigrationLock(new KyselyPostgresMigrationSessionProvider(secondDatabase))
    await Promise.all([firstLock, secondLock].map((lock) => lock.run(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 75))
      active -= 1
    })))
    expect(maximumActive).toBe(1)

    const firstAuthority = new KyselyAuthRepository(firstDatabase)
    const secondAuthority = new KyselyAuthRepository(secondDatabase)
    const first = new CachedAuthRepository(firstAuthority, firstRedis.sessionCache, new RedisFallbackCircuit({ failureThreshold: 1 }))
    const second = new CachedAuthRepository(secondAuthority, secondRedis.sessionCache, new RedisFallbackCircuit({ failureThreshold: 1 }))
    const user = storedUser('ha-user-1')
    const session = storedSession('ha-session-1', user.id)
    await first.createUser(user)
    await first.createSession(session)

    await expect(first.findSessionByTokenHash(session.tokenHash)).resolves.toEqual(session)
    await expect(second.findSessionByTokenHash(session.tokenHash)).resolves.toEqual(session)
    await expect(second.updateUserAndRevokeSessions(user.id, { enabled: false }, false)).resolves.toBe('updated')
    await expect(first.findSessionByTokenHash(session.tokenHash)).resolves.toBeUndefined()

    const wakeReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('REDIS_WAKE_TIMEOUT')), 5_000)
      timeout.unref()
      void firstRedis.transferWake.start(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    await secondRedis.transferWake.notify()
    await expect(wakeReceived).resolves.toBeUndefined()

    const fallbackUser = storedUser('ha-user-2')
    const fallbackSession = storedSession('ha-session-2', fallbackUser.id)
    await firstAuthority.createUser(fallbackUser)
    await firstAuthority.createSession(fallbackSession)
    await Promise.all([firstRedis.close(), secondRedis.close()])
    redisClosed = true
    await expect(first.findSessionByTokenHash(fallbackSession.tokenHash)).resolves.toEqual(fallbackSession)
  }, 30_000)

  it('allows only one PostgreSQL lease owner and permits takeover after expiry', async () => {
    const jobs = new KyselyTransferJobRepository(firstDatabase)
    const job = transferJob()
    await jobs.createWithinLimits(job, 2, 2)
    const first = new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(firstDatabase))
    const second = new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(secondDatabase))
    const claimed = await Promise.all([
      first.claim('worker-a', new Date('2026-08-01T00:00:00.000Z')),
      second.claim('worker-b', new Date('2026-08-01T00:00:00.000Z')),
    ])
    expect(claimed.filter(Boolean)).toHaveLength(1)
    await expect(second.claim('worker-b', new Date('2026-08-01T00:01:01.000Z')))
      .resolves.toMatchObject({ id: job.id, leaseOwner: 'worker-b', attemptCount: 2 })
  })

  it('enforces database operation limits across PostgreSQL-backed instances', async () => {
    const first = new DatabaseOperationLeaseService(
      new KyselyDatabaseOperationLeaseRepository(firstDatabase),
      { globalLimit: 2, connectionLimit: 1, leaseDurationMs: 60_000 },
    )
    const second = new DatabaseOperationLeaseService(
      new KyselyDatabaseOperationLeaseRepository(secondDatabase),
      { globalLimit: 2, connectionLimit: 1, leaseDurationMs: 60_000 },
    )
    const prefix = `operation-${Date.now()}`
    const startedAt = new Date()
    const acquired: DatabaseOperationLease[] = []

    try {
      const attempts = await Promise.all([
        first.tryAcquire(`${prefix}-owner-a`, `${prefix}-shared`, startedAt),
        second.tryAcquire(`${prefix}-owner-b`, `${prefix}-shared`, startedAt),
        second.tryAcquire(`${prefix}-owner-b`, `${prefix}-other`, startedAt),
      ])
      acquired.push(...attempts.flatMap((lease) => lease ? [lease] : []))
      expect(acquired).toHaveLength(2)
      expect(acquired.filter((lease) => lease.connectionId === `${prefix}-shared`)).toHaveLength(1)
      expect(acquired.filter((lease) => lease.connectionId === `${prefix}-other`)).toHaveLength(1)

      const shared = acquired.find((lease) => lease.connectionId === `${prefix}-shared`)!
      await (shared.ownerId.endsWith('owner-a') ? first : second).release(shared.id, shared.ownerId)
      acquired.splice(acquired.indexOf(shared), 1)
      const afterRelease = await first.tryAcquire(
        `${prefix}-owner-a`,
        `${prefix}-replacement`,
        startedAt,
      )
      expect(afterRelease).toMatchObject({ connectionId: `${prefix}-replacement` })
      acquired.push(afterRelease!)

      const afterExpiry = await first.tryAcquire(
        `${prefix}-owner-a`,
        `${prefix}-other`,
        new Date(startedAt.getTime() + 61_000),
      )
      expect(afterExpiry).toMatchObject({ connectionId: `${prefix}-other` })
      acquired.push(afterExpiry!)
    } finally {
      await Promise.all(acquired.map(async (lease) => {
        await (lease.ownerId.endsWith('owner-a') ? first : second)
          .release(lease.id, lease.ownerId)
          .catch(() => undefined)
      }))
    }
  })

  it('shares application-encrypted chunks across two MinIO clients', async () => {
    const masterKey = randomBytes(32)
    const firstStore = new S3EncryptedChunkStore({
      client: s3,
      bucket: s3Bucket,
      prefix: 'dbweb/ha-integration',
      purposeNamespace: 'source',
      encryption: new EnvelopeEncryption(masterKey),
    })
    const secondClient = new S3Client({
      region: 'us-east-1',
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
    })
    const secondStore = new S3EncryptedChunkStore({
      client: secondClient,
      bucket: s3Bucket,
      prefix: 'dbweb/ha-integration',
      purposeNamespace: 'source',
      encryption: new EnvelopeEncryption(masterKey),
    })
    const jobId = '77777777-7777-4777-8777-777777777777'
    const plaintext = Buffer.from('cross-instance-minio-chunk')
    const checksum = createHash('sha256').update(plaintext).digest('hex')
    try {
      await firstStore.put(jobId, 0, plaintext, checksum)
      await expect(secondStore.list(jobId)).resolves.toEqual([{ index: 0, size: plaintext.length, checksum }])
      await expect(secondStore.read(jobId, 0)).resolves.toEqual(plaintext)
    } finally {
      await secondStore.deleteJob(jobId)
      secondClient.destroy()
    }
  }, 30_000)
})

function storedUser(id: string): StoredUser {
  return {
    id,
    username: id,
    normalizedUsername: id,
    passwordHash: 'not-used-by-integration',
    role: 'user',
    enabled: true,
    passwordChangeRequired: false,
    sessionRevision: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
}

function storedSession(id: string, userId: string): StoredSession {
  return {
    id,
    userId,
    tokenHash: createHash('sha256').update(id).digest('hex'),
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    absoluteExpiresAt: '2026-08-01T12:00:00.000Z',
  }
}

function transferJob(): StoredTransferJob {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    ownerId: 'ha-user-1',
    connectionId: 'ha-connection-1',
    direction: 'export',
    format: 'json',
    includeData: true,
    status: 'previewed',
    receivedBytes: 0,
    processedBytes: 0,
    processedRows: 0,
    processedTables: 0,
    errorCount: 0,
    executionRequestedAt: '2026-08-01T00:00:00.000Z',
    executionRequestedBy: 'ha-user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
  }
}
