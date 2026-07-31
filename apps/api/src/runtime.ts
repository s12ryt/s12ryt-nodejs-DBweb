import { createHash, createHmac } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FastifyInstance } from 'fastify'

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
import { KeepAliveScheduler, SqlKeepAliveService } from './keepalive/sql-keepalive-service.js'
import { KyselyAuthRepository } from './metadata/kysely-auth-repository.js'
import { KyselyConnectionRepository } from './metadata/kysely-connection-repository.js'
import { KyselyDdlAuditRepository } from './metadata/kysely-ddl-audit-repository.js'
import { KyselyKeepAliveEventRepository } from './metadata/kysely-keepalive-event-repository.js'
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
import { KyselyWebAccessRepository } from './metadata/kysely-web-access-repository.js'
import {
  createMetadataDatabase,
  migrateMetadata,
  type MetadataDatabaseConfig,
} from './metadata/metadata-database.js'
import { MysqlSqlGateway } from './query/mysql-sql-gateway.js'
import { PostgresSqlGateway } from './query/postgres-sql-gateway.js'
import { SqlQueryService } from './query/sql-query-service.js'
import { EnvelopeEncryption } from './security/envelope-encryption.js'
import { EncryptedSecurityAuditRecorder } from './security/security-audit.js'
import { SshKnownHostService } from './ssh/ssh-known-host-service.js'
import { Ssh2TransportFactory } from './ssh/ssh2-transport-factory.js'
import { SshTunnelPool, type SshTransportFactory } from './ssh/ssh-tunnel-pool.js'
import { EncryptedChunkStore } from './transfers/encrypted-chunk-store.js'
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
import { TransferHandlerRouter } from './transfers/transfer-handler-router.js'
import { type CreateTransferJobInput, TransferJobService } from './transfers/transfer-job.js'
import { TransferOutputWriter } from './transfers/transfer-output-writer.js'
import { EncryptedTransferPreviewPlanStore } from './transfers/transfer-preview-plan.js'
import { TransferPreviewService } from './transfers/transfer-preview-service.js'
import { TransferPreviewTokenService } from './transfers/transfer-preview-token.js'
import { TransferUploadService } from './transfers/transfer-upload-service.js'

export interface RuntimeConfig {
  host: string
  port: number
  production: boolean
  metadata: MetadataDatabaseConfig
  masterKey: Buffer
  adminUsername: string
  adminPassword: string
  transferRoot?: string
  staticRoot?: string
}

export interface RuntimeDependencies {
  createSshTransportFactory?: (knownHosts: SshKnownHostService) => SshTransportFactory
  createTransferCleanupScheduler?: (
    service: TransferCleanupService,
  ) => Pick<TransferCleanupScheduler, 'start' | 'stop'>
  transferAuditRecorder?: TransferAuditRecorder
}

type RuntimeErrorCode =
  | 'BOOTSTRAP_ADMIN_CONFLICT'
  | 'INVALID_ADMIN_PASSWORD'
  | 'INVALID_MASTER_KEY'
  | 'INVALID_METADATA_URL'
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
  const transferRoot = resolve(env.DBWEB_TRANSFER_ROOT ?? './data/transfers')
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
    ...(staticRoot ? { staticRoot } : {}),
  }
}

export async function buildRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {},
): Promise<FastifyInstance> {
  if (config.metadata.kind === 'sqlite' && config.metadata.filename !== ':memory:') {
    await mkdir(dirname(config.metadata.filename), { recursive: true })
  }
  const database = createMetadataDatabase(config.metadata)
  let tunnelPool: SshTunnelPool | undefined
  let nativeAccountScheduler: NativeAccountVerificationScheduler | undefined
  let transferCleanupScheduler: Pick<TransferCleanupScheduler, 'start' | 'stop'> | undefined
  try {
    await migrateMetadata(database)
    const encryption = new EnvelopeEncryption(config.masterKey)
    const securityAudit = new EncryptedSecurityAuditRecorder(
      new KyselySecurityAuditRepository(database),
      encryption,
    )
    const authRepository = new KyselyAuthRepository(database)
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
    const postgresConnector = new PostgresConnector(undefined, undefined, socketProvider)
    const mysqlConnector = new MysqlConnector(undefined, undefined, socketProvider)
    const connectionService = new ConnectionService(
      new KyselyConnectionRepository(database),
      encryption,
      { postgres: postgresConnector, mysql: mysqlConnector },
    )
    const webAccessService = new WebAccessService(
      new KyselyWebAccessRepository(database),
      securityAudit,
    )
    const postgresDatabase = new PostgresDatabaseGateway(undefined, socketProvider)
    const mysqlDatabase = new MysqlDatabaseGateway(undefined, socketProvider)
    const databaseExplorer = new DatabaseExplorer(connectionService, {
      postgres: postgresDatabase,
      mysql: mysqlDatabase,
    })
    const dataMutationGateways = {
      postgres: new PostgresDataMutationGateway(undefined, socketProvider),
      mysql: new MysqlDataMutationGateway(undefined, socketProvider),
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
        postgres: new PostgresDdlGateway(undefined, socketProvider),
        mysql: new MysqlDdlGateway(undefined, socketProvider),
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
      postgres: new PostgresSqlGateway(undefined, socketProvider),
      mysql: new MysqlSqlGateway(undefined, socketProvider),
    }
    const queryService = new SqlQueryService(
      connectionService,
      sqlGateways,
      audit,
    )
    const nativeAccountRepository = new KyselyNativeAccountRepository(database)
    const nativeAccountCredentials = new NativeAccountCredentialVault(encryption)
    const nativeAccountGateways = {
      postgres: new PostgresNativeAccountGateway(undefined, socketProvider),
      mysql: new MysqlNativeAccountGateway(undefined, socketProvider),
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
        postgres: new PostgresNativeGrantGateway(undefined, socketProvider),
        mysql: new MysqlNativeGrantGateway(undefined, socketProvider),
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
    const transferRoot = config.transferRoot ?? resolve('./data/transfers')
    const transferSourceStore = new EncryptedChunkStore({
      root: join(transferRoot, 'source'),
      encryption,
      purposeNamespace: 'source',
    })
    const transferOutputStore = new EncryptedChunkStore({
      root: join(transferRoot, 'output'),
      encryption,
      purposeNamespace: 'output',
    })
    const transferJsonStageStore = new EncryptedChunkStore({
      root: join(transferRoot, 'json-stage'),
      encryption,
      purposeNamespace: 'json-stage',
    })
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
      postgres: new PostgresTransferDataGateway(undefined, undefined, socketProvider),
      mysql: new MysqlTransferDataGateway(undefined, undefined, socketProvider),
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
      {
        postgres: new PostgresExactJsonImportGateway(undefined, socketProvider),
        mysql: new MysqlExactJsonImportGateway(undefined, socketProvider),
      },
      sourcePackages,
      exactJsonImportPreview,
      (actor, job) => authorizeTransfer(webAccessService, actor, job),
      undefined,
      transferAudit,
    )
    const transferHandlers = new TransferHandlerRouter(transferJobService, {
      friendlyCsvExport: {
        inspect: (...args) => friendlyCsvPreview.inspect(...args),
        execute: (...args) => friendlyCsvExportService.execute(...args),
        cancel: (...args) => friendlyCsvExportService.cancel(...args),
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
    })
    const transferPreviewService = new TransferPreviewService(
      transferJobService,
      transferHandlers,
      transferPreviewTokens,
      transferPreviewPlans,
      transferAudit,
    )
    const transferCleanupService = new TransferCleanupService(
      transferJobRepository,
      [transferSourceStore, transferOutputStore, transferJsonStageStore],
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
      sshKnownHostService: knownHosts,
      webAccessService,
      csrfSecret,
      production: config.production,
      ...(config.staticRoot ? { staticRoot: config.staticRoot } : {}),
    })
    keepAliveScheduler.start()
    nativeAccountScheduler.start()
    transferCleanupScheduler.start()
    app.addHook('onClose', async () => {
      await transferCleanupScheduler?.stop()
      await nativeAccountScheduler?.stop()
      await keepAliveScheduler.stop()
      await tunnelPool?.close()
      await database.destroy()
    })
    return app
  } catch (error) {
    await transferCleanupScheduler?.stop()
    await nativeAccountScheduler?.stop()
    await tunnelPool?.close()
    await database.destroy()
    throw error
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
