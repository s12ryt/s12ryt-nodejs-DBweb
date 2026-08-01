import { createHash, createHmac, randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HeadBucketCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'

import { WebAccessService } from './access/web-access-service.js'
import { NativeAccountCredentialVault } from './accounts/native-account-credential.js'
import { MysqlNativeAccountGateway } from './accounts/mysql-native-account-gateway.js'
import { MysqlNativeGrantGateway } from './accounts/mysql-native-grant-gateway.js'
import { NativeAccountService } from './accounts/native-account-service.js'
import { NativeGrantService } from './accounts/native-grant-service.js'
import {
  NativeAccountVerificationScheduler,
  NativeAccountVerifier,
} from './accounts/native-account-verifier.js'
import { PostgresNativeAccountGateway } from './accounts/postgres-native-account-gateway.js'
import { PostgresNativeGrantGateway } from './accounts/postgres-native-grant-gateway.js'
import { buildApp } from './app.js'
import { EncryptedQueryAuditRecorder } from './audit/query-audit.js'
import { AuthService } from './auth/auth-service.js'
import { CachedAuthRepository } from './auth/cached-auth-repository.js'
import { ConnectionService } from './connections/connection-service.js'
import { TunnelDatabaseSocketProvider } from './connections/database-socket-provider.js'
import { MysqlConnector } from './connections/mysql-connector.js'
import { PostgresConnector } from './connections/postgres-connector.js'
import { DatabaseExplorer } from './database/database-explorer.js'
import { MysqlDatabaseGateway } from './database/mysql-database-gateway.js'
import { PostgresDatabaseGateway } from './database/postgres-database-gateway.js'
import { DataMutationService } from './data/data-mutation-service.js'
import { EncryptedMutationAuditRecorder } from './data/mutation-audit.js'
import { MysqlDataMutationGateway } from './data/mysql-data-mutation-gateway.js'
import { PostgresDataMutationGateway } from './data/postgres-data-mutation-gateway.js'
import { EncryptedDdlAuditRecorder } from './ddl/ddl-audit.js'
import { DdlService } from './ddl/ddl-service.js'
import { MysqlDdlGateway } from './ddl/mysql-ddl-gateway.js'
import { PostgresDdlGateway } from './ddl/postgres-ddl-gateway.js'
import { RetainedKeepAliveRecorder } from './keepalive/keepalive-event.js'
import {
  gateAsyncIterableGateway,
  gateOperationGateway,
  gateSessionFactory,
} from './ha/database-operation-adapters.js'
import {
  DatabaseOperationGate,
  DatabaseOperationLeaseService,
} from './ha/database-operation-gate.js'
import { RedisFallbackCircuit } from './ha/redis-fallback-circuit.js'
import { DependencyHealthService } from './ha/dependency-health-service.js'
import {
  InstanceRoleCoordinator,
  InstanceRoleHealthService,
} from './ha/instance-role-service.js'
import {
  KyselyPostgresMigrationSessionProvider,
  PostgresMigrationLock,
} from './ha/postgres-migration-lock.js'
import {
  createRedisRuntimeServices,
  type RedisRuntimeServices,
} from './ha/redis-runtime.js'
import { KeepAliveScheduler, SqlKeepAliveService } from './keepalive/sql-keepalive-service.js'
import { KyselyAuthRepository } from './metadata/kysely-auth-repository.js'
import { KyselyConnectionRepository } from './metadata/kysely-connection-repository.js'
import { KyselyDatabaseOperationLeaseRepository } from './metadata/kysely-database-operation-lease-repository.js'
import { KyselyDdlAuditRepository } from './metadata/kysely-ddl-audit-repository.js'
import { KyselyKeepAliveEventRepository } from './metadata/kysely-keepalive-event-repository.js'
import { KyselyInstanceRoleRepository } from './metadata/kysely-instance-role-repository.js'
import { KyselyMutationAuditRepository } from './metadata/kysely-mutation-audit-repository.js'
import { KyselyNativeAccountRepository } from './metadata/kysely-native-account-repository.js'
import { KyselyQueryAuditRepository } from './metadata/kysely-query-audit-repository.js'
import { KyselySecurityAuditRepository } from './metadata/kysely-security-audit-repository.js'
import {
  KyselySshHostKeyResetRecorder,
  KyselySshKnownHostRepository,
} from './metadata/kysely-ssh-known-host-repository.js'
import { KyselyTransferJobRepository } from './metadata/kysely-transfer-job-repository.js'
import { KyselyTransferAuditRepository } from './metadata/kysely-transfer-audit-repository.js'
import { KyselyTransferPreviewPlanRepository } from './metadata/kysely-transfer-preview-plan-repository.js'
import { KyselyTransferWorkerLeaseRepository } from './metadata/kysely-transfer-worker-lease-repository.js'
import { KyselyWebAccessRepository } from './metadata/kysely-web-access-repository.js'
import {
  createMetadataDatabase,
  migrateMetadata,
  type MetadataDatabaseConfig,
} from './metadata/metadata-database.js'
import { MysqlSqlGateway } from './query/mysql-sql-gateway.js'
import { MysqlSqlStreamGateway } from './query/mysql-sql-stream-gateway.js'
import { PostgresSqlGateway } from './query/postgres-sql-gateway.js'
import { PostgresSqlStreamGateway } from './query/postgres-sql-stream-gateway.js'
import { SqlQueryService } from './query/sql-query-service.js'
import { EnvelopeEncryption } from './security/envelope-encryption.js'
import { EncryptedSecurityAuditRecorder } from './security/security-audit.js'
import { SshKnownHostService } from './ssh/ssh-known-host-service.js'
import { Ssh2TransportFactory } from './ssh/ssh2-transport-factory.js'
import { SshTunnelPool, type SshTransportFactory } from './ssh/ssh-tunnel-pool.js'
import { EncryptedChunkStore } from './transfers/encrypted-chunk-store.js'
import {
  S3EncryptedChunkStore,
  type S3ChunkClient,
} from './transfers/s3-encrypted-chunk-store.js'
import { CsvTransferHandler } from './transfers/csv-transfer-handler.js'
import { ExactCsvExportService } from './transfers/exact-csv-export-service.js'
import { ExactCsvImportService } from './transfers/exact-csv-import-service.js'
import { ExactCsvPackageWriter, readExactCsvPackage } from './transfers/exact-csv-package.js'
import {
  ExactCsvExportPreviewCoordinator,
  ExactCsvImportPreviewCoordinator,
} from './transfers/exact-csv-preview.js'
import { ExactJsonExportService } from './transfers/exact-json-export-service.js'
import { ExactJsonImportPreviewCoordinator } from './transfers/exact-json-import-preview.js'
import { ExactJsonImportService } from './transfers/exact-json-import-service.js'
import { ExactJsonPackageWriter } from './transfers/exact-json-package-writer.js'
import { ExactJsonPreviewCoordinator } from './transfers/exact-json-preview.js'
import { EncryptedTransferAuditRecorder, type TransferAuditRecorder } from './transfers/transfer-audit.js'
import {
  TransferCleanupScheduler,
  TransferCleanupService,
} from './transfers/transfer-cleanup-service.js'
import { TransferDownloadService } from './transfers/transfer-download-service.js'
import { FriendlyCsvExportService } from './transfers/friendly-csv-export-service.js'
import { FriendlyCsvPreviewCoordinator } from './transfers/friendly-csv-preview.js'
import { MysqlExactJsonImportGateway } from './transfers/mysql-exact-json-import-gateway.js'
import { MysqlTransferDataGateway } from './transfers/mysql-transfer-data-gateway.js'
import { PostgresExactJsonImportGateway } from './transfers/postgres-exact-json-import-gateway.js'
import { PostgresTransferDataGateway } from './transfers/postgres-transfer-data-gateway.js'
import { MysqlSqlDumpSnapshotSessionFactory } from './transfers/mysql-sql-dump-snapshot.js'
import { PostgresSqlDumpSnapshotSessionFactory } from './transfers/postgres-sql-dump-snapshot.js'
import { SqlDumpExportPreviewCoordinator } from './transfers/sql-dump-export-preview.js'
import { SqlDumpExportService } from './transfers/sql-dump-export-service.js'
import { readSqlDumpPackage } from './transfers/sql-dump-package.js'
import { SqlDumpPackageWriter } from './transfers/sql-dump-package-writer.js'
import { SqlDumpSnapshotCatalog } from './transfers/sql-dump-snapshot-catalog.js'
import { MysqlSqlRestoreCatalogGateway } from './transfers/mysql-sql-restore-catalog-gateway.js'
import { MysqlSqlRestoreGateway } from './transfers/mysql-sql-restore-gateway.js'
import { loadMysqlSqlDumpData } from './transfers/mysql-sql-restore-data-loader.js'
import { PostgresSqlRestoreCatalogGateway } from './transfers/postgres-sql-restore-catalog-gateway.js'
import { PostgresSqlRestoreGateway } from './transfers/postgres-sql-restore-gateway.js'
import { loadPostgresSqlDumpData } from './transfers/postgres-sql-restore-data-loader.js'
import { SqlRestorePreviewCoordinator } from './transfers/sql-restore-preview.js'
import { SqlRestoreService } from './transfers/sql-restore-service.js'
import { TransferHandlerRouter } from './transfers/transfer-handler-router.js'
import { TransferExecutionQueue } from './transfers/transfer-execution-queue.js'
import { type CreateTransferJobInput, TransferJobService } from './transfers/transfer-job.js'
import {
  TransferJobWorker,
  TransferJobWorkerScheduler,
} from './transfers/transfer-job-worker.js'
import { TransferOutputWriter } from './transfers/transfer-output-writer.js'
import { EncryptedTransferPreviewPlanStore } from './transfers/transfer-preview-plan.js'
import { TransferPreviewService } from './transfers/transfer-preview-service.js'
import { TransferPreviewTokenService } from './transfers/transfer-preview-token.js'
import { TransferQueuedJobExecutor } from './transfers/transfer-queued-job-executor.js'
import { TransferUploadService } from './transfers/transfer-upload-service.js'
import { TransferWorkerLeaseService } from './transfers/transfer-worker-lease.js'

export interface RuntimeConfig {
  host: string
  port: number
  production: boolean
  metadata: MetadataDatabaseConfig
  masterKey: Buffer
  adminUsername: string
  adminPassword: string
  transferRoot?: string
  objectStorage?: TransferObjectStorageConfig
  redisUrl?: string
  haInstanceId?: string
  staticRoot?: string
}

export type TransferObjectStorageConfig =
  | { kind: 'filesystem'; root: string }
  | {
    kind: 's3'
    bucket: string
    region: string
    endpoint?: string
    forcePathStyle: boolean
    credentials?: { accessKeyId: string; secretAccessKey: string }
    serverSideEncryption?: 'AES256' | 'aws:kms'
    sseKmsKeyId?: string
  }

export interface S3RuntimeClient extends S3ChunkClient {
  destroy(): void
}

export interface RuntimeDependencies {
  createSshTransportFactory?: (knownHosts: SshKnownHostService) => SshTransportFactory
  createTransferCleanupScheduler?: (
    service: TransferCleanupService,
  ) => Pick<TransferCleanupScheduler, 'start' | 'stop'>
  transferAuditRecorder?: TransferAuditRecorder
  createRedisServices?: (
    url: string,
    circuit: RedisFallbackCircuit,
  ) => Promise<RedisRuntimeServices>
  createTransferWorkerScheduler?: (
    worker: TransferJobWorker,
  ) => Pick<TransferJobWorkerScheduler, 'start' | 'stop' | 'wake'>
  createS3Client?: (config: S3ClientConfig) => S3RuntimeClient
  databaseOperationGate?: DatabaseOperationGate
}

type RuntimeErrorCode =
  | 'BOOTSTRAP_ADMIN_CONFLICT'
  | 'INVALID_ADMIN_PASSWORD'
  | 'INVALID_MASTER_KEY'
  | 'INVALID_METADATA_URL'
  | 'INVALID_OBJECT_STORAGE'
  | 'INVALID_HA_INSTANCE'
  | 'INVALID_REDIS_URL'
  | 'INVALID_PORT'

export class RuntimeConfigError extends Error {
  constructor(readonly code: RuntimeErrorCode) {
    super(code)
    this.name = 'RuntimeConfigError'
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): RuntimeConfig {
  const masterKey = decodeMasterKey(env.DBWEB_MASTER_KEY)
  const adminPassword = env.DBWEB_ADMIN_PASSWORD ?? ''
  if (adminPassword.length < 12) throw new RuntimeConfigError('INVALID_ADMIN_PASSWORD')
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeConfigError('INVALID_PORT')
  }

  let metadata: MetadataDatabaseConfig
  if (env.DBWEB_METADATA_URL) {
    let url: URL
    try {
      url = new URL(env.DBWEB_METADATA_URL)
    } catch {
      throw new RuntimeConfigError('INVALID_METADATA_URL')
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new RuntimeConfigError('INVALID_METADATA_URL')
    }
    const maxConnections = Number(env.DBWEB_METADATA_MAX_CONNECTIONS ?? 10)
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100) {
      throw new RuntimeConfigError('INVALID_METADATA_URL')
    }
    metadata = { kind: 'postgres', connectionString: url.toString(), maxConnections }
  } else {
    metadata = {
      kind: 'sqlite',
      filename: resolve(env.DBWEB_METADATA_FILE ?? './data/dbweb.sqlite'),
    }
  }

  const production = env.NODE_ENV === 'production'
  const redisUrl = parseRedisUrl(env.DBWEB_REDIS_URL)
  const haInstanceId = env.DBWEB_HA_INSTANCE_ID?.trim()
  if (
    haInstanceId
    && (
      metadata.kind !== 'postgres'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(haInstanceId)
    )
  ) throw new RuntimeConfigError('INVALID_HA_INSTANCE')
  const transferRoot = resolve(env.DBWEB_TRANSFER_ROOT ?? './data/transfers')
  const objectStorage = parseObjectStorage(env, transferRoot)
  const staticRoot = env.DBWEB_WEB_ROOT
    ? resolve(env.DBWEB_WEB_ROOT)
    : production
      ? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
      : undefined

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    production,
    metadata,
    masterKey,
    adminUsername: env.DBWEB_ADMIN_USERNAME?.trim() || 'admin',
    adminPassword,
    transferRoot,
    objectStorage,
    ...(redisUrl ? { redisUrl } : {}),
    ...(haInstanceId ? { haInstanceId } : {}),
    ...(staticRoot ? { staticRoot } : {}),
  }
}

function parseObjectStorage(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  transferRoot: string,
): TransferObjectStorageConfig {
  const bucket = env.DBWEB_S3_BUCKET?.trim()
  if (!bucket) return { kind: 'filesystem', root: transferRoot }
  const region = env.DBWEB_S3_REGION?.trim()
  if (!region || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(region)) {
    throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
  }
  let endpoint: string | undefined
  if (env.DBWEB_S3_ENDPOINT?.trim()) {
    try {
      const parsed = new URL(env.DBWEB_S3_ENDPOINT)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      endpoint = parsed.toString()
    } catch {
      throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
    }
  }
  const accessKeyId = env.DBWEB_S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.DBWEB_S3_SECRET_ACCESS_KEY
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
  }
  const forcePathStyleValue = env.DBWEB_S3_FORCE_PATH_STYLE?.trim().toLowerCase()
  if (forcePathStyleValue && forcePathStyleValue !== 'true' && forcePathStyleValue !== 'false') {
    throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
  }
  const rawServerSideEncryption = env.DBWEB_S3_SSE?.trim()
  if (
    rawServerSideEncryption
    && rawServerSideEncryption !== 'AES256'
    && rawServerSideEncryption !== 'aws:kms'
  ) throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
  const serverSideEncryption: 'AES256' | 'aws:kms' | undefined = rawServerSideEncryption === 'AES256'
    || rawServerSideEncryption === 'aws:kms'
    ? rawServerSideEncryption
    : undefined
  const sseKmsKeyId = env.DBWEB_S3_KMS_KEY_ID?.trim()
  if (serverSideEncryption === 'aws:kms' && !sseKmsKeyId) {
    throw new RuntimeConfigError('INVALID_OBJECT_STORAGE')
  }
  return {
    kind: 's3',
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyleValue === 'true',
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    ...(serverSideEncryption ? { serverSideEncryption } : {}),
    ...(sseKmsKeyId ? { sseKmsKeyId } : {}),
  }
}

export async function buildRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {},
): Promise<FastifyInstance> {
  if (config.haInstanceId && config.metadata.kind !== 'postgres') {
    throw new RuntimeConfigError('INVALID_HA_INSTANCE')
  }
  if (config.metadata.kind === 'sqlite' && config.metadata.filename !== ':memory:') {
    await mkdir(dirname(config.metadata.filename), { recursive: true })
  }
  const database = createMetadataDatabase(config.metadata)
  let tunnelPool: SshTunnelPool | undefined
  let nativeAccountScheduler: NativeAccountVerificationScheduler | undefined
  let transferCleanupScheduler: Pick<TransferCleanupScheduler, 'start' | 'stop'> | undefined
  let transferWorkerScheduler: Pick<TransferJobWorkerScheduler, 'start' | 'stop' | 'wake'> | undefined
  let instanceRoleCoordinator: InstanceRoleCoordinator | undefined
  let redisServices: RedisRuntimeServices | undefined
  let s3Client: S3RuntimeClient | undefined
  const redisCircuit = config.redisUrl
    ? new RedisFallbackCircuit({ failureThreshold: 1 })
    : undefined
  try {
    if (config.metadata.kind === 'postgres') {
      await new PostgresMigrationLock(
        new KyselyPostgresMigrationSessionProvider(database),
      ).run(() => migrateMetadata(database))
    } else {
      await migrateMetadata(database)
    }
    const encryption = new EnvelopeEncryption(config.masterKey)
    const securityAudit = new EncryptedSecurityAuditRecorder(
      new KyselySecurityAuditRepository(database),
      encryption,
    )
    const authAuthority = new KyselyAuthRepository(database)
    if (config.redisUrl && redisCircuit) {
      await redisCircuit.run(
        async () => {
          redisServices = await (dependencies.createRedisServices ?? createRedisRuntimeServices)(
            config.redisUrl!,
            redisCircuit,
          )
        },
        async () => undefined,
      )
    }
    const authRepository = redisServices
      ? new CachedAuthRepository(authAuthority, redisServices.sessionCache, redisCircuit!)
      : authAuthority
    const authService = new AuthService(authRepository, {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
    }, securityAudit)
    const normalizedAdmin = config.adminUsername.toLocaleLowerCase('en-US')
    const existingAdmin = await authRepository.findUserByNormalizedUsername(normalizedAdmin)
    if (!existingAdmin) {
      await authService.createUser({
        username: config.adminUsername,
        password: config.adminPassword,
        role: 'admin',
      })
    } else if (existingAdmin.role !== 'admin') {
      throw new RuntimeConfigError('BOOTSTRAP_ADMIN_CONFLICT')
    }

    const knownHosts = new SshKnownHostService(
      new KyselySshKnownHostRepository(database),
      new KyselySshHostKeyResetRecorder(database),
    )
    const transportFactory = dependencies.createSshTransportFactory?.(knownHosts)
      ?? new Ssh2TransportFactory(knownHosts)
    const credentialKey = createHmac('sha256', config.masterKey)
      .update('dbweb-ssh-pool-credential-v1')
      .digest()
    tunnelPool = new SshTunnelPool(transportFactory, credentialKey)
    const socketProvider = new TunnelDatabaseSocketProvider(tunnelPool)
    const databaseOperationGate = dependencies.databaseOperationGate ?? new DatabaseOperationGate(
      new DatabaseOperationLeaseService(new KyselyDatabaseOperationLeaseRepository(database)),
      config.haInstanceId ?? randomUUID(),
    )
    const postgresConnector = gateOperationGateway(
      new PostgresConnector(undefined, undefined, socketProvider),
      databaseOperationGate,
    )
    const mysqlConnector = gateOperationGateway(
      new MysqlConnector(undefined, undefined, socketProvider),
      databaseOperationGate,
    )
    const connectionService = new ConnectionService(
      new KyselyConnectionRepository(database),
      encryption,
      { postgres: postgresConnector, mysql: mysqlConnector },
    )
    const webAccessService = new WebAccessService(
      new KyselyWebAccessRepository(database),
      securityAudit,
    )
    const postgresDatabase = gateOperationGateway(
      new PostgresDatabaseGateway(undefined, socketProvider),
      databaseOperationGate,
    )
    const mysqlDatabase = gateOperationGateway(
      new MysqlDatabaseGateway(undefined, socketProvider),
      databaseOperationGate,
    )
    const databaseExplorer = new DatabaseExplorer(connectionService, {
      postgres: postgresDatabase,
      mysql: mysqlDatabase,
    })
    const dataMutationGateways = {
      postgres: gateOperationGateway(
        new PostgresDataMutationGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
      mysql: gateOperationGateway(
        new MysqlDataMutationGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
    }
    const dataMutationService = new DataMutationService(
      connectionService,
      dataMutationGateways,
      new EncryptedMutationAuditRecorder(
        new KyselyMutationAuditRepository(database),
        encryption,
      ),
      undefined,
      (actor, connectionId) => webAccessService.can(actor, connectionId, 'data-write'),
    )
    const ddlService = new DdlService(
      connectionService,
      {
        postgres: gateOperationGateway(
          new PostgresDdlGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
        mysql: gateOperationGateway(
          new MysqlDdlGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
      },
      new EncryptedDdlAuditRecorder(new KyselyDdlAuditRepository(database), encryption),
      undefined,
      (actor, connectionId) => webAccessService.can(actor, connectionId, 'ddl-write'),
    )
    const audit = new EncryptedQueryAuditRecorder(
      new KyselyQueryAuditRepository(database),
      encryption,
    )
    const sqlGateways = {
      postgres: gateOperationGateway(
        new PostgresSqlGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
      mysql: gateOperationGateway(
        new MysqlSqlGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
    }
    const queryService = new SqlQueryService(
      connectionService,
      sqlGateways,
      audit,
      undefined,
      {
        postgres: gateAsyncIterableGateway(
          new PostgresSqlStreamGateway(undefined, undefined, socketProvider),
          databaseOperationGate,
        ),
        mysql: gateAsyncIterableGateway(
          new MysqlSqlStreamGateway(undefined, undefined, socketProvider),
          databaseOperationGate,
        ),
      },
    )
    const nativeAccountRepository = new KyselyNativeAccountRepository(database)
    const nativeAccountCredentials = new NativeAccountCredentialVault(encryption)
    const nativeAccountGateways = {
      postgres: gateOperationGateway(
        new PostgresNativeAccountGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
      mysql: gateOperationGateway(
        new MysqlNativeAccountGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
    }
    const nativeAccountService = new NativeAccountService(
      connectionService,
      nativeAccountGateways,
      nativeAccountRepository,
      nativeAccountCredentials,
      (actor, connectionId) => webAccessService.can(actor, connectionId, 'account-manage'),
      undefined,
      (actorId, password) => authService.verifyOwnPassword(actorId, password),
      securityAudit,
    )
    const nativeGrantService = new NativeGrantService(
      connectionService,
      nativeAccountGateways,
      {
        postgres: gateOperationGateway(
          new PostgresNativeGrantGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
        mysql: gateOperationGateway(
          new MysqlNativeGrantGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
      },
      (actor, connectionId) => webAccessService.can(actor, connectionId, 'account-manage'),
      securityAudit,
    )
    const nativeAccountVerifier = new NativeAccountVerifier(
      connectionService,
      nativeAccountGateways,
      nativeAccountRepository,
      nativeAccountCredentials,
      undefined,
      securityAudit,
    )
    nativeAccountScheduler = new NativeAccountVerificationScheduler(nativeAccountVerifier)
    const transferJobRepository = new KyselyTransferJobRepository(database)
    const transferAuditRepository = new KyselyTransferAuditRepository(database)
    const transferAudit = dependencies.transferAuditRecorder
      ?? new EncryptedTransferAuditRecorder(transferAuditRepository, encryption)
    const transferJobService = new TransferJobService(
      transferJobRepository,
      (actor, input) => authorizeTransfer(webAccessService, actor, input),
      undefined,
      transferAudit,
    )
    const objectStorage = config.objectStorage ?? {
      kind: 'filesystem' as const,
      root: config.transferRoot ?? resolve('./data/transfers'),
    }
    if (objectStorage.kind === 'filesystem') await mkdir(objectStorage.root, { recursive: true })
    if (objectStorage.kind === 's3') {
      const s3Config: S3ClientConfig = {
        region: objectStorage.region,
        forcePathStyle: objectStorage.forcePathStyle,
        ...(objectStorage.endpoint ? { endpoint: objectStorage.endpoint } : {}),
        ...(objectStorage.credentials ? { credentials: objectStorage.credentials } : {}),
      }
      s3Client = dependencies.createS3Client?.(s3Config)
        ?? (new S3Client(s3Config) as unknown as S3RuntimeClient)
    }
    const createTransferStore = (purposeNamespace: string) => objectStorage.kind === 's3'
      ? new S3EncryptedChunkStore({
        client: s3Client!,
        bucket: objectStorage.bucket,
        prefix: 'dbweb/transfers',
        purposeNamespace,
        encryption,
        ...(objectStorage.serverSideEncryption
          ? { serverSideEncryption: objectStorage.serverSideEncryption }
          : {}),
        ...(objectStorage.sseKmsKeyId ? { sseKmsKeyId: objectStorage.sseKmsKeyId } : {}),
      })
      : new EncryptedChunkStore({
        root: join(objectStorage.root, purposeNamespace),
        encryption,
        purposeNamespace,
      })
    const transferSourceStore = createTransferStore('source')
    const transferOutputStore = createTransferStore('output')
    const transferJsonStageStore = createTransferStore('json-stage')
    const transferCsvStageStore = createTransferStore('csv-stage')
    const transferSqlStageStore = createTransferStore('sql-stage')
    const transferUploadService = new TransferUploadService(
      transferJobService,
      transferSourceStore,
      undefined,
      undefined,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      transferAudit,
    )
    const transferDownloadService = new TransferDownloadService(
      transferJobService,
      transferOutputStore,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      transferAudit,
    )
    const transferPreviewTokens = new TransferPreviewTokenService(
      createHmac('sha256', config.masterKey)
        .update('dbweb-transfer-preview-token-v1')
        .digest(),
    )
    const transferPreviewPlanRepository = new KyselyTransferPreviewPlanRepository(database)
    const transferPreviewPlans = new EncryptedTransferPreviewPlanStore(
      transferPreviewPlanRepository,
      encryption,
      transferPreviewTokens,
    )
    const friendlyCsvPreview = new FriendlyCsvPreviewCoordinator(
      transferJobService,
      connectionService,
      dataMutationGateways,
      transferPreviewPlans,
      async (actor, job) => {
        const allowed = await webAccessService.can(actor, job.connectionId, 'data-read')
        return {
          allowed,
          fingerprint: createHash('sha256')
            .update(JSON.stringify({ capability: 'data-read', allowed }))
            .digest('hex'),
        }
      },
    )
    const transferDataGateways = {
      postgres: gateAsyncIterableGateway(
        new PostgresTransferDataGateway(undefined, undefined, socketProvider),
        databaseOperationGate,
      ),
      mysql: gateAsyncIterableGateway(
        new MysqlTransferDataGateway(undefined, undefined, socketProvider),
        databaseOperationGate,
      ),
    }
    const exactImportGateways = {
      postgres: gateOperationGateway(
        new PostgresExactJsonImportGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
      mysql: gateOperationGateway(
        new MysqlExactJsonImportGateway(undefined, socketProvider),
        databaseOperationGate,
      ),
    }
    const friendlyCsvExportService = new FriendlyCsvExportService(
      transferJobService,
      connectionService,
      transferDataGateways,
      new TransferOutputWriter(transferOutputStore),
      friendlyCsvPreview,
      (actor, job) => webAccessService.can(actor, job.connectionId, 'data-read'),
      undefined,
      transferAudit,
    )
    const exactJsonAuthorizer = async (
      actor: { id: string; role: 'admin' | 'user' },
      job: CreateTransferJobInput,
    ) => {
      const allowed = await authorizeTransfer(webAccessService, actor, job)
      return {
        allowed,
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ direction: job.direction, format: job.format, allowed }))
          .digest('hex'),
      }
    }
    const sourcePackages = { stream: (jobId: string) => streamStoredChunks(transferSourceStore, jobId) }
    const exactJsonExportPreview = new ExactJsonPreviewCoordinator(
      transferJobService,
      connectionService,
      dataMutationGateways,
      transferPreviewPlans,
      exactJsonAuthorizer,
    )
    const exactJsonImportPreview = new ExactJsonImportPreviewCoordinator(
      transferJobService,
      connectionService,
      dataMutationGateways,
      sourcePackages,
      transferPreviewPlans,
      exactJsonAuthorizer,
    )
    const exactJsonPackages = new ExactJsonPackageWriter(
      new TransferOutputWriter(transferJsonStageStore),
      transferJsonStageStore,
      new TransferOutputWriter(transferOutputStore),
    )
    const exactJsonExportService = new ExactJsonExportService(
      transferJobService,
      connectionService,
      transferDataGateways,
      exactJsonPackages,
      exactJsonExportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const exactJsonImportService = new ExactJsonImportService(
      transferJobService,
      connectionService,
      exactImportGateways,
      sourcePackages,
      exactJsonImportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const exactCsvExportPreview = new ExactCsvExportPreviewCoordinator(
      transferJobService,
      connectionService,
      dataMutationGateways,
      transferPreviewPlans,
      exactJsonAuthorizer,
    )
    const exactCsvImportPreview = new ExactCsvImportPreviewCoordinator(
      transferJobService,
      connectionService,
      dataMutationGateways,
      sourcePackages,
      { read: readExactCsvPackage },
      transferPreviewPlans,
      exactJsonAuthorizer,
    )
    const exactCsvPackages = new ExactCsvPackageWriter(
      new TransferOutputWriter(transferCsvStageStore),
      transferCsvStageStore,
      new TransferOutputWriter(transferOutputStore),
    )
    const exactCsvExportService = new ExactCsvExportService(
      transferJobService,
      connectionService,
      transferDataGateways,
      exactCsvPackages,
      exactCsvExportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const exactCsvImportService = new ExactCsvImportService(
      transferJobService,
      connectionService,
      exactImportGateways,
      sourcePackages,
      { read: readExactCsvPackage },
      exactCsvImportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const csvTransferHandler = new CsvTransferHandler(
      transferJobService,
      transferPreviewPlans,
      {
        inspect: (...args) => friendlyCsvPreview.inspect(...args),
        execute: (...args) => friendlyCsvExportService.execute(...args),
        cancel: (...args) => friendlyCsvExportService.cancel(...args),
      },
      {
        inspect: (...args) => exactCsvExportPreview.inspect(...args),
        execute: (...args) => exactCsvExportService.execute(...args),
        cancel: (...args) => exactCsvExportService.cancel(...args),
      },
      {
        inspect: (...args) => exactCsvImportPreview.inspect(...args),
        execute: (...args) => exactCsvImportService.execute(...args),
        cancel: (...args) => exactCsvImportService.cancel(...args),
      },
    )
    const sqlSnapshotCatalogs = {
      postgres: new SqlDumpSnapshotCatalog(
        gateSessionFactory(
          new PostgresSqlDumpSnapshotSessionFactory(undefined, undefined, socketProvider),
          databaseOperationGate,
        ),
      ),
      mysql: new SqlDumpSnapshotCatalog(
        gateSessionFactory(
          new MysqlSqlDumpSnapshotSessionFactory(undefined, undefined, socketProvider),
          databaseOperationGate,
        ),
      ),
    }
    const sqlTransferAuthorizer = async (
      actor: { id: string; role: 'admin' | 'user' },
      job: CreateTransferJobInput,
    ) => {
      const allowed = await authorizeTransfer(webAccessService, actor, job)
      return {
        allowed,
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ direction: job.direction, format: 'sql', includeData: job.includeData, allowed }))
          .digest('hex'),
      }
    }
    const sqlDumpExportPreview = new SqlDumpExportPreviewCoordinator(
      transferJobService,
      connectionService,
      sqlSnapshotCatalogs,
      transferPreviewPlans,
      sqlTransferAuthorizer,
    )
    const sqlDumpPackages = new SqlDumpPackageWriter(
      new TransferOutputWriter(transferSqlStageStore),
      transferSqlStageStore,
      new TransferOutputWriter(transferOutputStore),
    )
    const sqlDumpExportService = new SqlDumpExportService(
      transferJobService,
      connectionService,
      sqlSnapshotCatalogs,
      sqlDumpPackages,
      sqlDumpExportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const sqlSourcePackages = {
      readManifest: async (jobId: string) => (await readStoredSqlDumpPackage(
        transferSourceStore,
        jobId,
        async () => undefined,
      )).manifest,
      read: (
        jobId: string,
        handler: Parameters<typeof readSqlDumpPackage>[1],
      ) => readStoredSqlDumpPackage(transferSourceStore, jobId, handler).then(({ manifest }) => manifest),
    }
    const sqlRestorePreview = new SqlRestorePreviewCoordinator(
      transferJobService,
      connectionService,
      sqlSourcePackages,
      {
        postgres: gateOperationGateway(
          new PostgresSqlRestoreCatalogGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
        mysql: gateOperationGateway(
          new MysqlSqlRestoreCatalogGateway(undefined, socketProvider),
          databaseOperationGate,
        ),
      },
      transferPreviewPlans,
      sqlTransferAuthorizer,
    )
    const sqlRestoreService = new SqlRestoreService(
      transferJobService,
      connectionService,
      sqlRestorePreview,
      sqlSourcePackages,
      {
        postgres: gateSessionFactory(
          new PostgresSqlRestoreGateway(undefined, socketProvider, loadPostgresSqlDumpData),
          databaseOperationGate,
        ),
        mysql: gateSessionFactory(
          new MysqlSqlRestoreGateway(undefined, socketProvider, loadMysqlSqlDumpData),
          databaseOperationGate,
        ),
      },
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
    )
    const transferHandlers = new TransferHandlerRouter(transferJobService, {
      friendlyCsvExport: {
        inspect: (...args) => csvTransferHandler.inspect(...args),
        execute: (...args) => csvTransferHandler.execute(...args),
        cancel: (...args) => csvTransferHandler.cancel(...args),
      },
      exactJsonExport: {
        inspect: (...args) => exactJsonExportPreview.inspect(...args),
        execute: (...args) => exactJsonExportService.execute(...args),
        cancel: (...args) => exactJsonExportService.cancel(...args),
      },
      exactJsonImport: {
        inspect: (...args) => exactJsonImportPreview.inspect(...args),
        execute: (...args) => exactJsonImportService.execute(...args),
        cancel: (...args) => exactJsonImportService.cancel(...args),
      },
      sqlDumpExport: {
        inspect: (...args) => sqlDumpExportPreview.inspect(...args),
        execute: (...args) => sqlDumpExportService.execute(...args),
        cancel: (...args) => sqlDumpExportService.cancel(...args),
      },
      sqlRestore: {
        inspect: (...args) => sqlRestorePreview.inspect(...args),
        execute: (...args) => sqlRestoreService.execute(...args),
        cancel: (...args) => transferJobService.cancel(...args),
      },
    })
    const transferPreviewService = new TransferPreviewService(
      transferJobService,
      transferHandlers,
      transferPreviewTokens,
      transferPreviewPlans,
      transferAudit,
    )
    const transferExecutionQueue = new TransferExecutionQueue(
      transferJobService,
      transferPreviewPlans,
      redisServices?.transferWake ?? { notify: async () => undefined },
    )
    const transferWorker = new TransferJobWorker(
      randomUUID(),
      new TransferWorkerLeaseService(new KyselyTransferWorkerLeaseRepository(database)),
      new TransferQueuedJobExecutor(authAuthority, transferPreviewPlans, transferHandlers),
    )
    transferWorkerScheduler = dependencies.createTransferWorkerScheduler?.(transferWorker)
      ?? new TransferJobWorkerScheduler(transferWorker)
    const transferCleanupService = new TransferCleanupService(
      transferJobRepository,
      [transferSourceStore, transferOutputStore, transferJsonStageStore, transferCsvStageStore, transferSqlStageStore],
      [transferAuditRepository, transferPreviewPlanRepository],
    )
    transferCleanupScheduler = dependencies.createTransferCleanupScheduler?.(
      transferCleanupService,
    ) ?? new TransferCleanupScheduler(transferCleanupService)
    const keepAliveService = new SqlKeepAliveService(
      connectionService,
      sqlGateways,
      new RetainedKeepAliveRecorder(new KyselyKeepAliveEventRepository(database)),
    )
    const keepAliveScheduler = new KeepAliveScheduler(keepAliveService)
    const csrfSecret = createHmac('sha256', config.masterKey)
      .update('dbweb-csrf-v1')
      .digest()
    const dependencyHealthService = new DependencyHealthService({
      metadata: async () => {
        await database.selectNoFrom(sql<number>`1`.as('ok')).executeTakeFirstOrThrow()
      },
      objectStorage: objectStorage.kind === 's3'
        ? async () => {
          await s3Client!.send(new HeadBucketCommand({ Bucket: objectStorage.bucket }))
        }
        : async () => { await access(objectStorage.root) },
      ...(redisCircuit ? { redisState: () => redisCircuit.status().state } : {}),
    })
    if (config.haInstanceId) {
      instanceRoleCoordinator = new InstanceRoleCoordinator(
        new KyselyInstanceRoleRepository(database),
        config.haInstanceId,
        {
          onRoleChange: async (role) => {
            if (role === 'active') transferWorkerScheduler?.start()
            else await transferWorkerScheduler?.stop()
          },
        },
      )
    }
    const healthService = instanceRoleCoordinator
      ? new InstanceRoleHealthService(
        dependencyHealthService,
        () => instanceRoleCoordinator!.status().role,
      )
      : dependencyHealthService
    const app = await buildApp({
      authService,
      connectionService,
      databaseExplorer,
      dataMutationService,
      ddlService,
      queryService,
      nativeAccountService,
      nativeGrantService,
      transferJobService,
      transferUploadService,
      transferDownloadService,
      transferPreviewService,
      transferExecutionService: transferHandlers,
      transferExecutionQueue,
      healthService,
      sshKnownHostService: knownHosts,
      webAccessService,
      csrfSecret,
      production: config.production,
      ...(config.staticRoot ? { staticRoot: config.staticRoot } : {}),
    })
    keepAliveScheduler.start()
    nativeAccountScheduler.start()
    transferCleanupScheduler.start()
    if (instanceRoleCoordinator) await instanceRoleCoordinator.start()
    else transferWorkerScheduler.start()
    await redisServices?.transferWake.start(() => transferWorkerScheduler?.wake())
    app.addHook('onClose', async () => {
      await redisServices?.transferWake.close()
      if (instanceRoleCoordinator) await instanceRoleCoordinator.stop()
      else await transferWorkerScheduler?.stop()
      await transferCleanupScheduler?.stop()
      await nativeAccountScheduler?.stop()
      await keepAliveScheduler.stop()
      await tunnelPool?.close()
      await redisServices?.close()
      s3Client?.destroy()
      await database.destroy()
    })
    return app
  } catch (error) {
    await redisServices?.transferWake.close()
    if (instanceRoleCoordinator) await instanceRoleCoordinator.stop()
    else await transferWorkerScheduler?.stop()
    await transferCleanupScheduler?.stop()
    await nativeAccountScheduler?.stop()
    await tunnelPool?.close()
    await redisServices?.close()
    s3Client?.destroy()
    await database.destroy()
    throw error
  }
}

function parseRedisUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new RuntimeConfigError('INVALID_REDIS_URL')
    }
    return url.toString()
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error
    throw new RuntimeConfigError('INVALID_REDIS_URL')
  }
}

async function* streamStoredChunks(
  store: Pick<EncryptedChunkStore, 'list' | 'read'>,
  jobId: string,
): AsyncIterable<Buffer> {
  const chunks = await store.list(jobId)
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.index !== index) throw new Error('TRANSFER_CHUNK_SEQUENCE_INVALID')
    yield await store.read(jobId, index)
  }
}

async function readStoredSqlDumpPackage(
  store: Pick<EncryptedChunkStore, 'list' | 'read'>,
  jobId: string,
  handler: Parameters<typeof readSqlDumpPackage>[1],
) {
  const source = streamStoredChunks(store, jobId)
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error('SQL_DUMP_PACKAGE_EMPTY')
  const compression = first.value[0] === 0x1f && first.value[1] === 0x8b ? 'gzip' as const : 'none' as const
  const replay = async function* () {
    yield first.value
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  }
  return readSqlDumpPackage(replay(), handler, { compression })
}

async function authorizeTransfer(
  access: WebAccessService,
  actor: { id: string; role: 'admin' | 'user' },
  input: CreateTransferJobInput,
): Promise<boolean> {
  if (input.direction === 'import') {
    if (input.format === 'sql') {
      return await access.can(actor, input.connectionId, 'data-write')
        && await access.can(actor, input.connectionId, 'ddl-write')
    }
    return access.can(actor, input.connectionId, 'data-write')
  }
  if (input.format !== 'sql') return access.can(actor, input.connectionId, 'data-read')
  return await access.can(actor, input.connectionId, 'structure-read')
    && (input.includeData === false || await access.can(actor, input.connectionId, 'data-read'))
}

function decodeMasterKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new RuntimeConfigError('INVALID_MASTER_KEY')
  }
  const key = Buffer.from(value, 'base64url')
  if (key.length !== 32) throw new RuntimeConfigError('INVALID_MASTER_KEY')
  return key
}
