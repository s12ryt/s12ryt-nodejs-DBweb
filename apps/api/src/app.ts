import { createHmac, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'

import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { type WebCapability, type WebAccessService } from './access/web-access-service.js'
import { NativeAccountCredentialError } from './accounts/native-account-credential.js'
import { NativeAccountGatewayError } from './accounts/native-account-gateway-error.js'
import { NativeAccountPolicyError } from './accounts/native-account-policy.js'
import { NativeGrantGatewayError } from './accounts/native-grant-gateway.js'
import {
  NativeGrantValidationError,
  type NativeGrantCommand,
} from './accounts/native-grant-plan.js'
import { NativeGrantServiceError, type NativeGrantService } from './accounts/native-grant-service.js'
import {
  NativeAccountServiceError,
  type CreatedNativeAccount,
  type NativeAccountService,
  type StoredNativeAccount,
} from './accounts/native-account-service.js'
import { AuthError, type AuthService } from './auth/auth-service.js'
import type { AuthUser, UserRole } from './auth/auth-types.js'
import { ConnectionError, type ConnectionService } from './connections/connection-service.js'
import type { ConnectionInput } from './connections/connection-types.js'
import { DatabaseConnectionError } from './connections/connector-error.js'
import { ExplorerError, type DatabaseExplorer } from './database/database-explorer.js'
import {
  DataMutationError,
  type DataMutationRequest,
  type DataMutationService,
} from './data/data-mutation-service.js'
import { DdlValidationError, type DdlCommand } from './ddl/ddl-command.js'
import { DdlServiceError, type DdlService } from './ddl/ddl-service.js'
import { DatabaseOperationGateError } from './ha/database-operation-gate.js'
import {
  QueryError,
  type ExecuteQueryInput,
  type SqlQueryService,
} from './query/sql-query-service.js'
import type { SshKnownHostService } from './ssh/ssh-known-host-service.js'
import { CsvTransferHandlerError } from './transfers/csv-transfer-handler.js'
import { TransferChunkError } from './transfers/encrypted-chunk-store.js'
import { ExactCsvExportError } from './transfers/exact-csv-export-service.js'
import { ExactCsvImportError } from './transfers/exact-csv-import-service.js'
import { ExactCsvPreviewError } from './transfers/exact-csv-preview.js'
import { ExactJsonExportError } from './transfers/exact-json-export-service.js'
import { ExactJsonImportPreviewError } from './transfers/exact-json-import-preview.js'
import { ExactJsonImportError } from './transfers/exact-json-import-service.js'
import { ExactJsonPreviewError } from './transfers/exact-json-preview.js'
import {
  TransferDownloadError,
  type TransferDownloadService,
} from './transfers/transfer-download-service.js'
import {
  FriendlyCsvExportError,
  type FriendlyCsvExportService,
} from './transfers/friendly-csv-export-service.js'
import { FriendlyCsvPreviewError } from './transfers/friendly-csv-preview.js'
import { SqlDumpExportError } from './transfers/sql-dump-export-service.js'
import { SqlDumpExportPreviewError } from './transfers/sql-dump-export-preview.js'
import { SqlRestorePreviewError } from './transfers/sql-restore-preview.js'
import { SqlRestoreExecutionError } from './transfers/sql-restore-service.js'
import {
  TransferHandlerRouterError,
  type TransferExecutionHandler,
} from './transfers/transfer-handler-router.js'
import {
  TransferExecutionQueueError,
  type TransferExecutionQueue,
} from './transfers/transfer-execution-queue.js'
import {
  TransferJobError,
  type TransferJobService,
} from './transfers/transfer-job.js'
import {
  TransferUploadError,
  type TransferUploadService,
} from './transfers/transfer-upload-service.js'
import {
  TransferPreviewError,
  type TransferPreviewRequest,
  type TransferPreviewService,
} from './transfers/transfer-preview-service.js'
import type { HealthService } from './ha/health-service.js'

interface BuildAppOptions {
  authService: AuthService
  connectionService?: ConnectionService
  databaseExplorer?: DatabaseExplorer
  dataMutationService?: DataMutationService
  ddlService?: DdlService
  queryService?: SqlQueryService
  sshKnownHostService?: SshKnownHostService
  webAccessService?: WebAccessService
  nativeAccountService?: NativeAccountService
  nativeGrantService?: NativeGrantService
  transferJobService?: TransferJobService
  transferUploadService?: TransferUploadService
  transferDownloadService?: TransferDownloadService
  transferPreviewService?: TransferPreviewService
  friendlyCsvExportService?: FriendlyCsvExportService
  transferExecutionService?: TransferExecutionHandler
  transferExecutionQueue?: Pick<TransferExecutionQueue, 'request'>
  healthService?: HealthService
  csrfSecret: Buffer
  production: boolean
  staticRoot?: string
}

interface LoginBody {
  username: string
  password: string
}

interface CreateUserBody {
  username: string
  password?: string
  role: UserRole
}

const SESSION_COOKIE = 'dbweb_session'

const messages = {
  en: {
    FORBIDDEN: 'Insufficient permissions',
    CONNECTION_NOT_FOUND: 'Connection not found',
    CONFIRMATION_REQUIRED: 'Confirmation required for high-risk SQL',
    DATABASE_CONNECTION_FAILED: 'Database connection failed',
    DATABASE_OPERATION_BUSY: 'Database operation capacity is busy',
    DDL_CAPABILITY_UNSUPPORTED: 'DDL capability is not supported by this database version',
    DDL_COLUMN_DEFINITION_REQUIRED: 'A complete column definition is required',
    DDL_CONFIRMATION_REQUIRED: 'DDL confirmation required',
    DDL_FAILED: 'DDL execution failed',
    DDL_INVALID_DEFAULT: 'Invalid column default',
    DDL_INVALID_FRAGMENT: 'Invalid SQL fragment',
    DDL_INVALID_IDENTIFIER: 'Invalid database object name',
    DDL_INVALID_OPTION: 'Invalid DDL option',
    DDL_INVALID_TYPE_ARGUMENT: 'Invalid type argument',
    DDL_TYPE_UNSUPPORTED: 'Column type is not supported by this database version',
    INVALID_CONNECTION: 'Invalid connection settings',
    INVALID_KEEPALIVE_INTERVAL: 'Keepalive interval must be between 1 minute and 24 hours',
    INVALID_SSH_CONFIGURATION: 'Invalid SSH configuration',
    INVALID_TLS_CONFIGURATION: 'Invalid TLS configuration',
    INVALID_CREDENTIALS: 'Invalid username or password',
    INVALID_PAGE: 'Invalid page parameters',
    INVALID_QUERY: 'Invalid query parameters',
    INVALID_CSRF: 'Invalid CSRF token',
    INVALID_MUTATION: 'Invalid data mutation',
    NATIVE_ACCOUNT_CONFIRMATION_REQUIRED: 'Native database account confirmation required',
    INVALID_SESSION: 'Authentication required',
    INVALID_NATIVE_ACCOUNT: 'Invalid native database account',
    LAST_ENABLED_ADMIN: 'At least one enabled administrator is required',
    PASSWORD_CHANGE_REQUIRED: 'Password change required',
    SESSION_EXPIRED: 'Session expired',
    QUERY_CANCELLED: 'Query cancelled',
    QUERY_FAILED: 'Query execution failed',
    QUERY_NOT_ACTIVE: 'Query is not active',
    QUERY_TIMEOUT: 'Query timed out',
    READ_ONLY_QUERY_REQUIRED: 'Only a single read-only SQL statement is allowed',
    MUTATION_FAILED: 'Data mutation failed',
    NATIVE_ACCOUNT_FAILED: 'Native database account operation failed',
    NATIVE_GRANT_FAILED: 'Native database grant operation failed',
    NATIVE_GRANT_CONFIRMATION_REQUIRED: 'Native database grant revocation requires confirmation',
    INVALID_NATIVE_GRANT: 'Invalid native database grant',
    SYSTEM_DATABASE_PROTECTED: 'This system database is protected',
    UNSUPPORTED_NATIVE_PRIVILEGE: 'This privilege is not supported for the selected scope',
    ACCOUNT_NOT_FOUND: 'Native database account not found',
    PROTECTED_ACCOUNT: 'This database account is protected',
    REAUTHENTICATION_FAILED: 'Password verification failed',
    RECOVERY_EXPIRED: 'The account recovery period has expired',
    ROW_CONFLICT: 'The row changed or no longer exists',
    TABLE_WITHOUT_STABLE_KEY: 'Table has no stable unique key',
    UNSUPPORTED_COLUMN: 'Column cannot be modified',
    UNAUTHORIZED: 'Authentication required',
    USERNAME_TAKEN: 'Username is already in use',
    USER_NOT_FOUND: 'User not found',
    WEAK_PASSWORD: 'Password must contain at least 12 characters',
    WEAK_NATIVE_ACCOUNT_PASSWORD: 'Native database account passwords must contain at least 16 characters',
    ACTIVE_JOB_LIMIT_REACHED: 'Active transfer job limit reached',
    INVALID_JOB: 'Invalid transfer job',
    JOB_NOT_FOUND: 'Transfer job not found',
    INVALID_JOB_TRANSITION: 'Invalid transfer job state transition',
    INVALID_JOB_PROGRESS: 'Invalid transfer job progress',
    INVALID_CHUNK: 'Invalid transfer chunk',
    CHUNK_CHECKSUM_MISMATCH: 'Transfer chunk checksum mismatch',
    CHUNK_CONFLICT: 'Transfer chunk conflicts with an existing chunk',
    CHUNK_TOO_LARGE: 'Transfer chunk is too large',
    TRANSFER_TOO_LARGE: 'Transfer exceeds the size limit',
    CHUNK_NOT_FOUND: 'Transfer chunk not found',
    CHUNK_CORRUPTED: 'Transfer chunk is corrupted',
    UPLOAD_NOT_ALLOWED: 'Upload is not allowed for this transfer job',
    UPLOAD_ALREADY_COMPLETED: 'Transfer upload is already complete',
    INCOMPLETE_UPLOAD: 'Transfer upload is incomplete',
    FILE_SIZE_MISMATCH: 'Transfer file size mismatch',
    FILE_CHECKSUM_MISMATCH: 'Transfer file checksum mismatch',
    DOWNLOAD_NOT_READY: 'Transfer output is not ready for download',
    OUTPUT_NOT_FOUND: 'Transfer output was not found',
    UPLOAD_INCOMPLETE: 'Transfer upload must be completed before preview',
    INVALID_PREVIEW: 'Transfer preview settings are invalid',
    PREVIEW_CHANGED: 'Transfer preview is stale and must be regenerated',
    PREVIEW_EXPIRED: 'Transfer preview has expired',
    PREVIEW_NOT_FOUND: 'Transfer preview was not found',
    FORMULA_CONFIRMATION_REQUIRED: 'Raw spreadsheet formula values require confirmation',
    EXPORT_CANCELLED: 'Transfer export was cancelled',
    EXPORT_FAILED: 'Transfer export failed',
    INVALID_EXPORT_JOB: 'Transfer job cannot run this export',
    INVALID_IMPORT_JOB: 'Transfer job cannot run this import',
    IMPORT_CANCELLED: 'Transfer import was cancelled',
    IMPORT_FAILED: 'Transfer import failed',
    TRANSFER_CONFIRMATION_REQUIRED: 'Transfer operation requires confirmation',
    UNSUPPORTED_TRANSFER_HANDLER: 'This transfer format and direction are not supported',
    EXECUTION_ALREADY_REQUESTED: 'Transfer execution has already been requested',
    INVALID_EXECUTION_REQUEST: 'Transfer execution request is invalid',
    INVALID_RESTORE_JOB: 'Transfer job cannot run this SQL restore',
    RESTORE_CANCELLED: 'SQL restore was cancelled',
    RESTORE_CHANGED: 'SQL restore preview is stale and must be regenerated',
    RESTORE_FAILED: 'SQL restore failed',
  },
  'zh-TW': {
    FORBIDDEN: '權限不足',
    CONNECTION_NOT_FOUND: '找不到連線設定',
    CONFIRMATION_REQUIRED: '高風險 SQL 需要二次確認',
    DATABASE_CONNECTION_FAILED: '資料庫連線失敗',
    DATABASE_OPERATION_BUSY: '資料庫操作容量忙碌中',
    DDL_CAPABILITY_UNSUPPORTED: '此資料庫版本不支援該 DDL 能力',
    DDL_COLUMN_DEFINITION_REQUIRED: '需要完整的欄位定義',
    DDL_CONFIRMATION_REQUIRED: 'DDL 操作需要二次確認',
    DDL_FAILED: 'DDL 執行失敗',
    DDL_INVALID_DEFAULT: '欄位預設值無效',
    DDL_INVALID_FRAGMENT: 'SQL 片段無效',
    DDL_INVALID_IDENTIFIER: '資料庫物件名稱無效',
    DDL_INVALID_OPTION: 'DDL 選項無效',
    DDL_INVALID_TYPE_ARGUMENT: '型別參數無效',
    DDL_TYPE_UNSUPPORTED: '此資料庫版本不支援該欄位型別',
    INVALID_CONNECTION: '連線設定無效',
    INVALID_KEEPALIVE_INTERVAL: '保活間隔必須介於 1 分鐘到 24 小時',
    INVALID_SSH_CONFIGURATION: 'SSH 設定無效',
    INVALID_TLS_CONFIGURATION: 'TLS 設定無效',
    INVALID_CREDENTIALS: '使用者名稱或密碼錯誤',
    INVALID_PAGE: '分頁參數無效',
    INVALID_QUERY: '查詢參數無效',
    INVALID_CSRF: 'CSRF 驗證失敗',
    INVALID_MUTATION: '資料異動內容無效',
    NATIVE_ACCOUNT_CONFIRMATION_REQUIRED: '原生資料庫帳號操作需要二次確認',
    INVALID_SESSION: '需要登入',
    INVALID_NATIVE_ACCOUNT: '原生資料庫帳號設定無效',
    LAST_ENABLED_ADMIN: '至少需要保留一位已啟用的管理員',
    PASSWORD_CHANGE_REQUIRED: '必須先變更密碼',
    SESSION_EXPIRED: '登入階段已過期',
    QUERY_CANCELLED: '查詢已取消',
    QUERY_FAILED: '查詢執行失敗',
    QUERY_NOT_ACTIVE: '查詢未在執行中',
    QUERY_TIMEOUT: '查詢逾時',
    READ_ONLY_QUERY_REQUIRED: '只允許單一唯讀 SQL 語句',
    MUTATION_FAILED: '資料異動失敗',
    NATIVE_ACCOUNT_FAILED: '原生資料庫帳號操作失敗',
    NATIVE_GRANT_FAILED: '原生資料庫權限異動失敗',
    NATIVE_GRANT_CONFIRMATION_REQUIRED: '撤銷原生資料庫權限需要二次確認',
    INVALID_NATIVE_GRANT: '原生資料庫權限設定無效',
    SYSTEM_DATABASE_PROTECTED: '此系統資料庫受保護',
    UNSUPPORTED_NATIVE_PRIVILEGE: '所選範圍不支援此權限',
    ACCOUNT_NOT_FOUND: '找不到原生資料庫帳號',
    PROTECTED_ACCOUNT: '此資料庫帳號受保護',
    REAUTHENTICATION_FAILED: '密碼驗證失敗',
    RECOVERY_EXPIRED: '帳號復原期限已過',
    ROW_CONFLICT: '資料列已變更或不存在',
    TABLE_WITHOUT_STABLE_KEY: '資料表沒有穩定的唯一鍵',
    UNSUPPORTED_COLUMN: '欄位不可修改',
    UNAUTHORIZED: '需要登入',
    USERNAME_TAKEN: '使用者名稱已被使用',
    USER_NOT_FOUND: '找不到使用者',
    WEAK_PASSWORD: '密碼至少需要 12 個字元',
    WEAK_NATIVE_ACCOUNT_PASSWORD: '原生資料庫帳號密碼至少需要 16 個字元',
    ACTIVE_JOB_LIMIT_REACHED: '進行中的傳輸工作已達上限',
    INVALID_JOB: '傳輸工作設定無效',
    JOB_NOT_FOUND: '找不到傳輸工作',
    INVALID_JOB_TRANSITION: '傳輸工作狀態轉換無效',
    INVALID_JOB_PROGRESS: '傳輸工作進度無效',
    INVALID_CHUNK: '傳輸分段無效',
    CHUNK_CHECKSUM_MISMATCH: '傳輸分段校驗碼不符',
    CHUNK_CONFLICT: '傳輸分段與既有內容衝突',
    CHUNK_TOO_LARGE: '傳輸分段超過大小限制',
    TRANSFER_TOO_LARGE: '傳輸檔案超過大小限制',
    CHUNK_NOT_FOUND: '找不到傳輸分段',
    CHUNK_CORRUPTED: '傳輸分段已損毀',
    UPLOAD_NOT_ALLOWED: '此傳輸工作不允許上傳',
    UPLOAD_ALREADY_COMPLETED: '傳輸上傳已完成',
    INCOMPLETE_UPLOAD: '傳輸上傳尚未完整',
    FILE_SIZE_MISMATCH: '傳輸檔案大小不符',
    FILE_CHECKSUM_MISMATCH: '傳輸檔案校驗碼不符',
    DOWNLOAD_NOT_READY: '傳輸輸出尚未可供下載',
    OUTPUT_NOT_FOUND: '找不到傳輸輸出',
    UPLOAD_INCOMPLETE: '必須先完成傳輸檔案上傳才能預覽',
    INVALID_PREVIEW: '傳輸預覽設定無效',
    PREVIEW_CHANGED: '傳輸預覽已失效，請重新產生',
    PREVIEW_EXPIRED: '傳輸預覽已過期',
    PREVIEW_NOT_FOUND: '找不到傳輸預覽',
    FORMULA_CONFIRMATION_REQUIRED: '原始試算表公式值需要二次確認',
    EXPORT_CANCELLED: '傳輸匯出已取消',
    EXPORT_FAILED: '傳輸匯出失敗',
    INVALID_EXPORT_JOB: '此傳輸工作無法執行該匯出',
    INVALID_IMPORT_JOB: '此傳輸工作無法執行該匯入',
    IMPORT_CANCELLED: '傳輸匯入已取消',
    IMPORT_FAILED: '傳輸匯入失敗',
    TRANSFER_CONFIRMATION_REQUIRED: '傳輸操作需要確認',
    UNSUPPORTED_TRANSFER_HANDLER: '不支援此傳輸格式與方向',
    EXECUTION_ALREADY_REQUESTED: '已要求執行此傳輸工作',
    INVALID_EXECUTION_REQUEST: '傳輸執行要求無效',
    INVALID_RESTORE_JOB: '此傳輸工作無法執行 SQL 還原',
    RESTORE_CANCELLED: 'SQL 還原已取消',
    RESTORE_CHANGED: 'SQL 還原預覽已失效，請重新產生',
    RESTORE_FAILED: 'SQL 還原失敗',
  },
} as const

type ErrorCode = keyof (typeof messages)['en']

function localeOf(request: FastifyRequest): keyof typeof messages {
  return request.headers['accept-language']?.toLowerCase().startsWith('en') ? 'en' : 'zh-TW'
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
) {
  return reply.code(statusCode).send({
    error: { code, message: messages[localeOf(request)][code] },
  })
}

function handleUserLifecycleError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (!(error instanceof AuthError)) throw error
  if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
  if (error.code === 'LAST_ENABLED_ADMIN') {
    return sendError(request, reply, 409, 'LAST_ENABLED_ADMIN')
  }
  if (error.code === 'USER_NOT_FOUND') return sendError(request, reply, 404, 'USER_NOT_FOUND')
  if (error.code === 'WEAK_PASSWORD') return sendError(request, reply, 422, 'WEAK_PASSWORD')
  throw error
}

function handleNativeAccountError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof NativeAccountGatewayError) {
    return sendError(request, reply, 502, 'NATIVE_ACCOUNT_FAILED')
  }
  if (error instanceof NativeAccountCredentialError) {
    return sendError(request, reply, 422, 'WEAK_NATIVE_ACCOUNT_PASSWORD')
  }
  if (error instanceof NativeAccountPolicyError) {
    return sendError(request, reply, 422, 'INVALID_NATIVE_ACCOUNT')
  }
  if (!(error instanceof NativeAccountServiceError)) throw error
  if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
  if (error.code === 'ACCOUNT_NOT_FOUND') return sendError(request, reply, 404, 'ACCOUNT_NOT_FOUND')
  if (error.code === 'CONFIRMATION_REQUIRED') {
    return sendError(request, reply, 409, 'NATIVE_ACCOUNT_CONFIRMATION_REQUIRED')
  }
  if (error.code === 'PROTECTED_ACCOUNT') {
    return sendError(request, reply, 409, 'PROTECTED_ACCOUNT')
  }
  if (error.code === 'RECOVERY_EXPIRED') {
    return sendError(request, reply, 410, 'RECOVERY_EXPIRED')
  }
  if (error.code === 'REAUTHENTICATION_FAILED') {
    return sendError(request, reply, 401, 'REAUTHENTICATION_FAILED')
  }
  if (error.code === 'INVALID_ACCOUNT') {
    return sendError(request, reply, 422, 'INVALID_NATIVE_ACCOUNT')
  }
  throw error
}

function handleNativeGrantError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof NativeGrantGatewayError) {
    return reply.code(502).send({
      error: {
        code: 'NATIVE_GRANT_FAILED',
        message: messages[localeOf(request)].NATIVE_GRANT_FAILED,
        appliedCount: error.appliedCount,
        failedIndex: error.failedIndex,
      },
    })
  }
  if (error instanceof NativeGrantValidationError) {
    const status = error.code === 'NATIVE_GRANT_CONFIRMATION_REQUIRED' ? 409 : 422
    return sendError(request, reply, status, error.code)
  }
  if (!(error instanceof NativeGrantServiceError)) throw error
  if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
  if (error.code === 'ACCOUNT_NOT_FOUND') return sendError(request, reply, 404, 'ACCOUNT_NOT_FOUND')
  if (error.code === 'PROTECTED_ACCOUNT') return sendError(request, reply, 409, 'PROTECTED_ACCOUNT')
  return reply.code(502).send({
    error: {
      code: 'NATIVE_GRANT_FAILED',
      message: messages[localeOf(request)].NATIVE_GRANT_FAILED,
      ...(error.appliedCount === undefined ? {} : { appliedCount: error.appliedCount }),
      ...(error.failedIndex === undefined ? {} : { failedIndex: error.failedIndex }),
    },
  })
}

function handleTransferError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof TransferJobError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'JOB_NOT_FOUND') return sendError(request, reply, 404, 'JOB_NOT_FOUND')
    if (error.code === 'ACTIVE_JOB_LIMIT_REACHED' || error.code === 'INVALID_JOB_TRANSITION') {
      return sendError(request, reply, 409, error.code)
    }
    return sendError(request, reply, 422, error.code)
  }
  if (error instanceof TransferExecutionQueueError) {
    return sendError(request, reply, 409, error.code)
  }
  if (error instanceof TransferChunkError) {
    if (error.code === 'CHUNK_NOT_FOUND') return sendError(request, reply, 404, error.code)
    if (error.code === 'CHUNK_CONFLICT') return sendError(request, reply, 409, error.code)
    if (error.code === 'CHUNK_TOO_LARGE' || error.code === 'TRANSFER_TOO_LARGE') {
      return sendError(request, reply, 413, error.code)
    }
    return sendError(request, reply, 422, error.code)
  }
  if (error instanceof TransferUploadError) {
    if (error.code === 'UPLOAD_NOT_ALLOWED' || error.code === 'UPLOAD_ALREADY_COMPLETED') {
      return sendError(request, reply, 409, error.code)
    }
    return sendError(request, reply, 422, error.code)
  }
  if (error instanceof TransferDownloadError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'OUTPUT_NOT_FOUND') return sendError(request, reply, 404, error.code)
    return sendError(request, reply, 409, error.code)
  }
  if (error instanceof TransferPreviewError) {
    return sendError(request, reply, error.code === 'UPLOAD_INCOMPLETE' ? 409 : 422, error.code)
  }
  if (error instanceof FriendlyCsvPreviewError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'PREVIEW_NOT_FOUND') return sendError(request, reply, 404, error.code)
    if (error.code === 'PREVIEW_CHANGED' || error.code === 'PREVIEW_EXPIRED') {
      return sendError(request, reply, 409, error.code)
    }
    if (error.code === 'CONFIRMATION_REQUIRED') {
      return sendError(request, reply, 409, 'FORMULA_CONFIRMATION_REQUIRED')
    }
    return sendError(request, reply, 422, 'INVALID_PREVIEW')
  }
  if (
    error instanceof ExactJsonPreviewError
    || error instanceof ExactJsonImportPreviewError
    || error instanceof ExactCsvPreviewError
    || error instanceof SqlDumpExportPreviewError
    || error instanceof SqlRestorePreviewError
  ) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'PREVIEW_NOT_FOUND') return sendError(request, reply, 404, error.code)
    if (error.code === 'PREVIEW_CHANGED' || error.code === 'PREVIEW_EXPIRED') {
      return sendError(request, reply, 409, error.code)
    }
    if (
      (
        error instanceof ExactJsonImportPreviewError
        || error instanceof ExactCsvPreviewError
        || error instanceof SqlRestorePreviewError
      )
      && error.code === 'CONFIRMATION_REQUIRED'
    ) {
      return sendError(request, reply, 409, 'TRANSFER_CONFIRMATION_REQUIRED')
    }
    return sendError(request, reply, 422, 'INVALID_PREVIEW')
  }
  if (error instanceof FriendlyCsvExportError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'EXPORT_CANCELLED') return sendError(request, reply, 409, error.code)
    if (error.code === 'INVALID_EXPORT_JOB') return sendError(request, reply, 409, error.code)
    return sendError(request, reply, 502, 'EXPORT_FAILED')
  }
  if (
    error instanceof ExactJsonExportError
    || error instanceof ExactCsvExportError
    || error instanceof SqlDumpExportError
  ) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'EXPORT_CANCELLED' || error.code === 'INVALID_EXPORT_JOB') {
      return sendError(request, reply, 409, error.code)
    }
    return sendError(request, reply, 502, 'EXPORT_FAILED')
  }
  if (error instanceof ExactJsonImportError || error instanceof ExactCsvImportError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'IMPORT_CANCELLED' || error.code === 'INVALID_IMPORT_JOB') {
      return sendError(request, reply, 409, error.code)
    }
    return sendError(request, reply, 502, 'IMPORT_FAILED')
  }
  if (error instanceof TransferHandlerRouterError) {
    return sendError(request, reply, 422, error.code)
  }
  if (error instanceof CsvTransferHandlerError) {
    return sendError(request, reply, 422, 'UNSUPPORTED_TRANSFER_HANDLER')
  }
  if (error instanceof SqlRestoreExecutionError) {
    if (error.code === 'FORBIDDEN') return sendError(request, reply, 403, 'FORBIDDEN')
    if (error.code === 'INVALID_RESTORE_JOB' || error.code === 'RESTORE_CANCELLED') {
      return sendError(request, reply, 409, error.code)
    }
    if (error.code === 'RESTORE_CHANGED') return sendError(request, reply, 409, error.code)
    return reply.code(502).send({
      error: {
        code: 'RESTORE_FAILED',
        message: messages[localeOf(request)].RESTORE_FAILED,
        appliedSteps: error.appliedSteps,
        ...(error.failedStep === undefined ? {} : { failedStep: error.failedStep }),
      },
    })
  }
  throw error
}

function publicManagedAccount(account: StoredNativeAccount) {
  const { encryptedPassword: _encryptedPassword, ...publicAccount } = account
  void _encryptedPassword
  return publicAccount
}

function publicCreatedNativeAccount(result: CreatedNativeAccount) {
  return {
    account: publicManagedAccount(result.account),
    ...(result.password === undefined ? {} : { password: result.password }),
  }
}

function csrfTokenFor(sessionToken: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(sessionToken).digest('base64url')
}

function csrfMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false
  const expectedBytes = Buffer.from(expected)
  const receivedBytes = Buffer.from(received)
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DatabaseOperationGateError && error.code === 'DATABASE_OPERATION_BUSY') {
      reply.header('retry-after', '1')
      return sendError(request, reply, 503, 'DATABASE_OPERATION_BUSY')
    }
    return reply.send(error)
  })

  await app.register(cookie)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  })
  await app.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' })
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    allowPasswordChange = false,
  ): Promise<AuthUser | undefined> {
    const token = request.cookies[SESSION_COOKIE]
    if (!token) {
      sendError(request, reply, 401, 'UNAUTHORIZED')
      return undefined
    }

    try {
      const user = await options.authService.authenticate(token)
      if (user.passwordChangeRequired && !allowPasswordChange) {
        sendError(request, reply, 403, 'PASSWORD_CHANGE_REQUIRED')
        return undefined
      }
      return user
    } catch (error) {
      if (error instanceof AuthError) {
        const code = error.code === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'INVALID_SESSION'
        sendError(request, reply, 401, code)
        return undefined
      }
      throw error
    }
  }

  function validateCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
    const sessionToken = request.cookies[SESSION_COOKIE]
    const received = request.headers['x-csrf-token']
    if (
      !sessionToken ||
      typeof received !== 'string' ||
      !csrfMatches(csrfTokenFor(sessionToken, options.csrfSecret), received)
    ) {
      sendError(request, reply, 403, 'INVALID_CSRF')
      return false
    }
    return true
  }

  app.get('/api/health/live', async () => ({ status: 'live' }))
  if (options.healthService) {
    app.get('/api/health/ready', async (_request, reply) => {
      const health = await options.healthService!.check()
      return reply.code(health.ready ? 200 : 503).send({
        status: health.ready ? 'ready' : 'not-ready',
        degraded: health.degraded,
        ...(health.role === undefined ? {} : { role: health.role }),
      })
    })
    app.get('/api/health', async () => {
      const health = await options.healthService!.check()
      return {
        status: health.ready ? health.degraded ? 'degraded' : 'ok' : 'not-ready',
        ...(health.role === undefined ? {} : { role: health.role }),
        components: health.components,
      }
    })
  } else {
    app.get('/api/health/ready', async () => ({ status: 'ready', degraded: false }))
    app.get('/api/health', async () => ({ status: 'ok' }))
  }

  if (options.transferJobService && options.transferUploadService) {
    const jobs = options.transferJobService
    const uploads = options.transferUploadService
    const jobParamsSchema = {
      type: 'object', additionalProperties: false, required: ['jobId'],
      properties: { jobId: { type: 'string', format: 'uuid' } },
    } as const

    app.post<{
      Body: {
        connectionId: string
        direction: 'import' | 'export'
        format: 'csv' | 'json' | 'sql'
        includeData?: boolean
      }
    }>(
      '/api/transfers',
      {
        schema: {
          body: {
            type: 'object', additionalProperties: false,
            required: ['connectionId', 'direction', 'format'],
            properties: {
              connectionId: { type: 'string', minLength: 1, maxLength: 128 },
              direction: { type: 'string', enum: ['import', 'export'] },
              format: { type: 'string', enum: ['csv', 'json', 'sql'] },
              includeData: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        try {
          return reply.code(201).send(await jobs.create(actor, request.body))
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    app.get('/api/transfers', async (request, reply) => {
      const actor = await authenticate(request, reply)
      if (!actor) return
      return jobs.list(actor)
    })

    app.get<{ Params: { jobId: string } }>(
      '/api/transfers/:jobId',
      { schema: { params: jobParamsSchema } },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor) return
        try {
          return await jobs.get(actor, request.params.jobId)
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    app.post<{ Params: { jobId: string }; Body: Record<string, never> }>(
      '/api/transfers/:jobId/cancel',
      {
        schema: {
          params: jobParamsSchema,
          body: { type: 'object', additionalProperties: false, maxProperties: 0 },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        try {
          return options.transferExecutionService
            ? await options.transferExecutionService.cancel(actor, request.params.jobId)
            : options.friendlyCsvExportService
              ? await options.friendlyCsvExportService.cancel(actor, request.params.jobId)
            : await jobs.cancel(actor, request.params.jobId)
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    app.get<{ Params: { jobId: string } }>(
      '/api/transfers/:jobId/chunks',
      { schema: { params: jobParamsSchema } },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor) return
        try {
          return await uploads.list(actor, request.params.jobId)
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    app.put<{
      Params: { jobId: string; index: number }
      Headers: { 'x-chunk-sha256'?: string }
      Body: Buffer
    }>(
      '/api/transfers/:jobId/chunks/:index',
      {
        schema: {
          params: {
            type: 'object', additionalProperties: false, required: ['jobId', 'index'],
            properties: {
              jobId: { type: 'string', format: 'uuid' },
              index: { type: 'integer', minimum: 0 },
            },
          },
          headers: {
            type: 'object',
            required: ['x-chunk-sha256'],
            properties: { 'x-chunk-sha256': { type: 'string', pattern: '^[0-9a-f]{64}$' } },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        try {
          return await uploads.put(
            actor,
            request.params.jobId,
            request.params.index,
            request.body,
            request.headers['x-chunk-sha256'] as string,
          )
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { jobId: string }
      Body: { size: number; checksum: string }
    }>(
      '/api/transfers/:jobId/upload-complete',
      {
        schema: {
          params: jobParamsSchema,
          body: {
            type: 'object', additionalProperties: false, required: ['size', 'checksum'],
            properties: {
              size: { type: 'integer', minimum: 0, maximum: 10 * 1024 * 1024 * 1024 },
              checksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        try {
          return await uploads.complete(
            actor,
            request.params.jobId,
            request.body.size,
            request.body.checksum,
          )
        } catch (error) {
          return handleTransferError(request, reply, error)
        }
      },
    )

    if (options.transferDownloadService) {
      const downloads = options.transferDownloadService
      app.get<{ Params: { jobId: string } }>(
        '/api/transfers/:jobId/download',
        { schema: { params: jobParamsSchema } },
        async (request, reply) => {
          const actor = await authenticate(request, reply)
          if (!actor) return
          try {
            const download = await downloads.open(actor, request.params.jobId)
            return reply
              .header('content-type', 'application/octet-stream')
              .header('content-length', String(download.size))
              .header('content-disposition', `attachment; filename="${download.filename}"`)
              .send(Readable.from(download.stream))
          } catch (error) {
            return handleTransferError(request, reply, error)
          }
        },
      )
    }

    if (options.transferPreviewService) {
      const previews = options.transferPreviewService
      app.post<{ Params: { jobId: string }; Body: TransferPreviewRequest }>(
        '/api/transfers/:jobId/preview',
        {
          schema: {
            params: jobParamsSchema,
            body: {
              type: 'object', additionalProperties: false,
              required: ['mapping', 'strategy', 'target'],
              properties: {
                mapping: { type: 'object' },
                strategy: { type: 'object' },
                target: { type: 'object' },
              },
            },
          },
        },
        async (request, reply) => {
          const actor = await authenticate(request, reply)
          if (!actor || !validateCsrf(request, reply)) return
          try {
            return await previews.preview(actor, request.params.jobId, request.body)
          } catch (error) {
            return handleTransferError(request, reply, error)
          }
        },
      )
    }

    const transferExecutions = options.transferExecutionService ?? options.friendlyCsvExportService
    if (options.transferExecutionQueue || transferExecutions) {
      app.post<{ Params: { jobId: string }; Body: { previewToken: string } }>(
        '/api/transfers/:jobId/execute',
        {
          schema: {
            params: jobParamsSchema,
            body: {
              type: 'object', additionalProperties: false, required: ['previewToken'],
              properties: { previewToken: { type: 'string', minLength: 1, maxLength: 8192 } },
            },
          },
        },
        async (request, reply) => {
          const actor = await authenticate(request, reply)
          if (!actor || !validateCsrf(request, reply)) return
          try {
            if (options.transferExecutionQueue) {
              const requested = await options.transferExecutionQueue.request(
                actor,
                request.params.jobId,
                request.body.previewToken,
              )
              return reply.code(202).send(requested)
            }
            if (!transferExecutions) throw new TransferHandlerRouterError('UNSUPPORTED_TRANSFER_HANDLER')
            return await transferExecutions.execute(actor, request.params.jobId, request.body.previewToken)
          } catch (error) {
            return handleTransferError(request, reply, error)
          }
        },
      )
    }
  }

  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 128 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await options.authService.login(request.body.username, request.body.password)
        reply.setCookie(SESSION_COOKIE, result.token, {
          httpOnly: true,
          path: '/',
          sameSite: 'strict',
          secure: options.production,
          maxAge: 12 * 60 * 60,
        })
        return {
          user: result.user,
          csrfToken: csrfTokenFor(result.token, options.csrfSecret),
        }
      } catch (error) {
        if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
          return sendError(request, reply, 401, 'INVALID_CREDENTIALS')
        }
        throw error
      }
    },
  )

  app.get('/api/auth/me', async (request, reply) => {
    const user = await authenticate(request, reply, true)
    if (!user) return
    const token = request.cookies[SESSION_COOKIE]
    return {
      user,
      csrfToken: csrfTokenFor(token as string, options.csrfSecret),
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const user = await authenticate(request, reply, true)
    if (!user || !validateCsrf(request, reply)) return
    const token = request.cookies[SESSION_COOKIE]
    if (token) await options.authService.logout(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.post<{ Body: CreateUserBody }>(
    '/api/users',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'role'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 128 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            role: { type: 'string', enum: ['admin', 'user'] },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, reply)
      if (!actor || !validateCsrf(request, reply)) return
      if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')

      try {
        const result = await options.authService.createManagedUser(actor, request.body)
        return reply.code(201).send(result)
      } catch (error) {
        if (error instanceof AuthError && (error.code === 'USERNAME_TAKEN' || error.code === 'WEAK_PASSWORD')) {
          return sendError(request, reply, 409, error.code)
        }
        throw error
      }
    },
  )

  const userIdParamsSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['userId'],
    properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
  } as const

  app.get('/api/users', async (request, reply) => {
    const actor = await authenticate(request, reply)
    if (!actor) return
    try {
      return await options.authService.listUsers(actor)
    } catch (error) {
      if (error instanceof AuthError && error.code === 'FORBIDDEN') {
        return sendError(request, reply, 403, 'FORBIDDEN')
      }
      throw error
    }
  })

  app.patch<{
    Params: { userId: string }
    Body: { enabled?: boolean; role?: UserRole }
  }>(
    '/api/users/:userId',
    {
      schema: {
        params: userIdParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 1,
          properties: {
            enabled: { type: 'boolean' },
            role: { type: 'string', enum: ['admin', 'user'] },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, reply)
      if (!actor || !validateCsrf(request, reply)) return
      try {
        if (request.body.enabled !== undefined) {
          return await options.authService.setUserEnabled(actor, request.params.userId, request.body.enabled)
        }
        return await options.authService.setUserRole(
          actor,
          request.params.userId,
          request.body.role as UserRole,
        )
      } catch (error) {
        return handleUserLifecycleError(request, reply, error)
      }
    },
  )

  app.post<{
    Params: { userId: string }
    Body: { password?: string }
  }>(
    '/api/users/:userId/reset-password',
    {
      schema: {
        params: userIdParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, reply)
      if (!actor || !validateCsrf(request, reply)) return
      try {
        return await options.authService.resetUserPassword(
          actor,
          request.params.userId,
          request.body.password,
        )
      } catch (error) {
        return handleUserLifecycleError(request, reply, error)
      }
    },
  )

  app.delete<{
    Params: { userId: string }
    Body: { confirmed: boolean }
  }>(
    '/api/users/:userId',
    {
      schema: {
        params: userIdParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['confirmed'],
          properties: { confirmed: { const: true } },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, reply)
      if (!actor || !validateCsrf(request, reply)) return
      try {
        await options.authService.deleteUser(actor, request.params.userId)
        return reply.code(204).send()
      } catch (error) {
        return handleUserLifecycleError(request, reply, error)
      }
    },
  )

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/change-password',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
            newPassword: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, reply, true)
      if (!actor || !validateCsrf(request, reply)) return
      try {
        await options.authService.changeOwnPassword(
          actor,
          request.body.currentPassword,
          request.body.newPassword,
        )
        return reply.code(204).send()
      } catch (error) {
        if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
          return sendError(request, reply, 401, 'INVALID_CREDENTIALS')
        }
        if (error instanceof AuthError && error.code === 'WEAK_PASSWORD') {
          return sendError(request, reply, 422, 'WEAK_PASSWORD')
        }
        throw error
      }
    },
  )

  if (options.webAccessService) {
    const accessService = options.webAccessService
    const accessParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['userId', 'connectionId'],
      properties: {
        userId: { type: 'string', minLength: 1, maxLength: 128 },
        connectionId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const
    const capabilityValues: WebCapability[] = [
      'structure-read',
      'data-read',
      'query-read',
      'data-write',
      'ddl-write',
      'account-manage',
    ]

    app.get<{ Params: { userId: string } }>(
      '/api/users/:userId/access',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['userId'],
            properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        return accessService.listAssignments(actor, request.params.userId)
      },
    )

    app.put<{
      Params: { userId: string; connectionId: string }
      Body: { capabilities?: WebCapability[] }
    }>(
      '/api/users/:userId/connections/:connectionId/access',
      {
        schema: {
          params: accessParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              capabilities: {
                type: 'array',
                uniqueItems: true,
                items: { type: 'string', enum: capabilityValues },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        return accessService.assign(
          actor,
          request.params.userId,
          request.params.connectionId,
          request.body.capabilities,
        )
      },
    )

    app.delete<{ Params: { userId: string; connectionId: string } }>(
      '/api/users/:userId/connections/:connectionId/access',
      { schema: { params: accessParamsSchema } },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        await accessService.revoke(actor, request.params.userId, request.params.connectionId)
        return reply.code(204).send()
      },
    )
  }

  if (options.nativeAccountService) {
    const nativeAccounts = options.nativeAccountService
    const connectionAccountParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const
    const managedAccountParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'accountId'],
      properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 128 },
        accountId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const
    const confirmationBodySchema = {
      type: 'object',
      additionalProperties: false,
      required: ['confirmed'],
      properties: { confirmed: { const: true } },
    } as const

    async function requireNativeAccountAccess(
      request: FastifyRequest,
      reply: FastifyReply,
      connectionId: string,
      requireCsrf: boolean,
    ): Promise<AuthUser | undefined> {
      const actor = await authenticate(request, reply)
      if (!actor || (requireCsrf && !validateCsrf(request, reply))) return undefined
      if (
        options.webAccessService
        && !(await options.webAccessService.can(actor, connectionId, 'account-manage'))
      ) {
        sendError(request, reply, 403, 'FORBIDDEN')
        return undefined
      }
      return actor
    }

    app.get<{ Params: { connectionId: string } }>(
      '/api/connections/:connectionId/accounts',
      { schema: { params: connectionAccountParamsSchema } },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(
          request,
          reply,
          request.params.connectionId,
          false,
        )
        if (!actor) return
        try {
          return await nativeAccounts.list(actor, request.params.connectionId)
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string }
      Body: {
        identity: { username: string; host?: string }
        password?: string
        connectionLimit?: number
        verificationDatabase?: string
        verificationIntervalMs?: number
        confirmed: boolean
      }
    }>(
      '/api/connections/:connectionId/accounts',
      {
        schema: {
          params: connectionAccountParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['identity', 'confirmed'],
            properties: {
              identity: {
                type: 'object',
                additionalProperties: false,
                required: ['username'],
                properties: {
                  username: { type: 'string', minLength: 1, maxLength: 128 },
                  host: { type: 'string', minLength: 1, maxLength: 255 },
                },
              },
              password: { type: 'string', minLength: 1, maxLength: 1024 },
              connectionLimit: { type: 'integer', minimum: -1 },
              verificationDatabase: { type: 'string', minLength: 1, maxLength: 128 },
              verificationIntervalMs: { type: 'integer', minimum: 3_600_000, maximum: 604_800_000 },
              confirmed: { const: true },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(
          request,
          reply,
          request.params.connectionId,
          true,
        )
        if (!actor) return
        try {
          const result = await nativeAccounts.create(actor, {
            connectionId: request.params.connectionId,
            ...request.body,
          })
          return reply.code(201).send(publicCreatedNativeAccount(result))
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string }
      Body: {
        identity: { username: string; host?: string }
        password?: string
        verificationDatabase?: string
        verificationIntervalMs?: number
        confirmed: boolean
      }
    }>(
      '/api/connections/:connectionId/accounts/adopt',
      {
        schema: {
          params: connectionAccountParamsSchema,
          body: {
            type: 'object', additionalProperties: false, required: ['identity', 'confirmed'],
            properties: {
              identity: {
                type: 'object', additionalProperties: false, required: ['username'],
                properties: {
                  username: { type: 'string', minLength: 1, maxLength: 128 },
                  host: { type: 'string', minLength: 1, maxLength: 255 },
                },
              },
              password: { type: 'string', minLength: 1, maxLength: 1024 },
              verificationDatabase: { type: 'string', minLength: 1, maxLength: 128 },
              verificationIntervalMs: { type: 'integer', minimum: 3_600_000, maximum: 604_800_000 },
              confirmed: { const: true },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          const result = await nativeAccounts.adopt(actor, {
            connectionId: request.params.connectionId,
            ...request.body,
          })
          return reply.code(201).send(publicCreatedNativeAccount(result))
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string; accountId: string }
      Body: { password?: string }
    }>(
      '/api/connections/:connectionId/accounts/:accountId/rotate-password',
      {
        schema: {
          params: managedAccountParamsSchema,
          body: {
            type: 'object', additionalProperties: false,
            properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          return publicCreatedNativeAccount(await nativeAccounts.rotatePassword(
            actor,
            request.params.accountId,
            request.body.password,
          ))
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string; accountId: string }
      Body: Record<string, never>
    }>(
      '/api/connections/:connectionId/accounts/:accountId/verify',
      {
        schema: {
          params: managedAccountParamsSchema,
          body: { type: 'object', additionalProperties: false, maxProperties: 0 },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          await nativeAccounts.verifyNow(actor, request.params.accountId)
          return reply.code(204).send()
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string; accountId: string }
      Body: { webPassword: string }
    }>(
      '/api/connections/:connectionId/accounts/:accountId/reveal-password',
      {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
          params: managedAccountParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['webPassword'],
            properties: { webPassword: { type: 'string', minLength: 1, maxLength: 1024 } },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(
          request,
          reply,
          request.params.connectionId,
          true,
        )
        if (!actor) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        try {
          const password = await nativeAccounts.revealPassword(
            actor,
            request.params.accountId,
            request.body.webPassword,
          )
          return { password }
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.patch<{
      Params: { connectionId: string; accountId: string }
      Body: { enabled: boolean; confirmed?: boolean }
    }>(
      '/api/connections/:connectionId/accounts/:accountId',
      {
        schema: {
          params: managedAccountParamsSchema,
          body: {
            type: 'object', additionalProperties: false, required: ['enabled'],
            properties: { enabled: { type: 'boolean' }, confirmed: { type: 'boolean' } },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          await nativeAccounts.setEnabled(
            actor,
            request.params.accountId,
            request.body.enabled,
            request.body.confirmed === true,
          )
          return reply.code(204).send()
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.delete<{
      Params: { connectionId: string; accountId: string }
      Body: { confirmed: true }
    }>(
      '/api/connections/:connectionId/accounts/:accountId',
      { schema: { params: managedAccountParamsSchema, body: confirmationBodySchema } },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          await nativeAccounts.delete(actor, request.params.accountId, request.body.confirmed)
          return reply.code(204).send()
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )

    app.post<{
      Params: { connectionId: string; accountId: string }
      Body: { confirmed: true }
    }>(
      '/api/connections/:connectionId/accounts/:accountId/restore',
      { schema: { params: managedAccountParamsSchema, body: confirmationBodySchema } },
      async (request, reply) => {
        const actor = await requireNativeAccountAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          await nativeAccounts.restore(actor, request.params.accountId, request.body.confirmed)
          return reply.code(204).send()
        } catch (error) {
          return handleNativeAccountError(request, reply, error)
        }
      },
    )
  }

  if (options.nativeGrantService) {
    const nativeGrants = options.nativeGrantService
    const paramsSchema = {
      type: 'object', additionalProperties: false, required: ['connectionId'],
      properties: { connectionId: { type: 'string', minLength: 1, maxLength: 128 } },
    } as const
    const identitySchema = {
      type: 'object', additionalProperties: false, required: ['engine', 'username'],
      properties: {
        engine: { type: 'string', enum: ['postgres', 'mysql'] },
        username: { type: 'string', minLength: 1, maxLength: 128 },
        host: { type: 'string', minLength: 1, maxLength: 255 },
      },
    } as const
    const changeSchema = {
      type: 'object', additionalProperties: false, required: ['scope', 'database', 'privileges'],
      properties: {
        scope: { type: 'string', enum: ['database', 'schema', 'table'] },
        database: { type: 'string', minLength: 1, maxLength: 128 },
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        table: { type: 'string', minLength: 1, maxLength: 128 },
        privileges: {
          type: 'array', minItems: 1, maxItems: 11, uniqueItems: true,
          items: {
            type: 'string',
            enum: ['connect', 'usage', 'select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'index', 'references'],
          },
        },
      },
    } as const

    async function requireGrantAccess(
      request: FastifyRequest,
      reply: FastifyReply,
      connectionId: string,
      csrf: boolean,
    ): Promise<AuthUser | undefined> {
      const actor = await authenticate(request, reply)
      if (!actor || (csrf && !validateCsrf(request, reply))) return undefined
      if (
        options.webAccessService
        && !(await options.webAccessService.can(actor, connectionId, 'account-manage'))
      ) {
        sendError(request, reply, 403, 'FORBIDDEN')
        return undefined
      }
      return actor
    }

    app.get<{
      Params: { connectionId: string }
      Querystring: { targetDatabase: string; engine: 'postgres' | 'mysql'; username: string; host?: string }
    }>(
      '/api/connections/:connectionId/accounts/grants',
      {
        schema: {
          params: paramsSchema,
          querystring: {
            type: 'object', additionalProperties: false,
            required: ['targetDatabase', 'engine', 'username'],
            properties: {
              targetDatabase: { type: 'string', minLength: 1, maxLength: 128 },
              engine: { type: 'string', enum: ['postgres', 'mysql'] },
              username: { type: 'string', minLength: 1, maxLength: 128 },
              host: { type: 'string', minLength: 1, maxLength: 255 },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireGrantAccess(request, reply, request.params.connectionId, false)
        if (!actor) return
        const identity = request.query.engine === 'postgres'
          ? { engine: 'postgres' as const, username: request.query.username }
          : { engine: 'mysql' as const, username: request.query.username, host: request.query.host ?? '%' }
        try {
          return await nativeGrants.list(
            actor,
            request.params.connectionId,
            request.query.targetDatabase,
            identity,
          )
        } catch (error) {
          return handleNativeGrantError(request, reply, error)
        }
      },
    )

    app.post<{ Params: { connectionId: string }; Body: NativeGrantCommand }>(
      '/api/connections/:connectionId/accounts/grants',
      {
        schema: {
          params: paramsSchema,
          body: {
            type: 'object', additionalProperties: false, required: ['kind', 'identity', 'changes'],
            properties: {
              kind: { type: 'string', enum: ['grant', 'revoke'] },
              identity: identitySchema,
              changes: { type: 'array', minItems: 1, maxItems: 100, items: changeSchema },
              confirmed: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireGrantAccess(request, reply, request.params.connectionId, true)
        if (!actor) return
        try {
          return await nativeGrants.execute(actor, request.params.connectionId, request.body)
        } catch (error) {
          return handleNativeGrantError(request, reply, error)
        }
      },
    )
  }

  if (options.connectionService) {
    const connectionService = options.connectionService

    app.get('/api/connections', async (request, reply) => {
      const user = await authenticate(request, reply)
      if (!user) return
      const profiles = await connectionService.list()
      if (!options.webAccessService) return profiles
      const visibleIds = await options.webAccessService.listVisibleConnectionIds(user)
      if (!visibleIds) return profiles
      const visible = new Set(visibleIds)
      return profiles.filter((profile) => visible.has(profile.id))
    })

    app.post<{ Body: ConnectionInput }>(
      '/api/connections',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name',
              'engine',
              'host',
              'port',
              'database',
              'username',
              'password',
              'tls',
              'keepAlive',
            ],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 128 },
              engine: { type: 'string', enum: ['postgres', 'mysql'] },
              host: { type: 'string', minLength: 1, maxLength: 255 },
              port: { type: 'integer', minimum: 1, maximum: 65_535 },
              database: { type: 'string', minLength: 1, maxLength: 128 },
              username: { type: 'string', minLength: 1, maxLength: 128 },
              password: { type: 'string', maxLength: 1024 },
              tls: {
                type: 'object',
                additionalProperties: false,
                required: ['mode'],
                properties: {
                  mode: {
                    type: 'string',
                    enum: ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'],
                  },
                  ca: { type: 'string', maxLength: 100_000 },
                  certificate: { type: 'string', maxLength: 100_000 },
                  privateKey: { type: 'string', maxLength: 100_000 },
                },
              },
              keepAlive: {
                type: 'object',
                additionalProperties: false,
                required: ['enabled'],
                properties: {
                  enabled: { type: 'boolean' },
                  intervalMs: { type: 'integer' },
                },
              },
              ssh: {
                type: 'object',
                additionalProperties: false,
                required: ['enabled'],
                properties: {
                  enabled: { type: 'boolean' },
                  host: { type: 'string', maxLength: 255 },
                  port: { type: 'integer' },
                  username: { type: 'string', maxLength: 128 },
                  password: { type: 'string', maxLength: 1024 },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        try {
          return reply.code(201).send(await connectionService.create(request.body, actor.id))
        } catch (error) {
          if (error instanceof ConnectionError) {
            return sendError(request, reply, 422, error.code)
          }
          throw error
        }
      },
    )

    app.post<{ Params: { id: string } }>(
      '/api/connections/:id/test',
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        try {
          return await connectionService.testConnection(request.params.id)
        } catch (error) {
          if (error instanceof ConnectionError) {
            return sendError(request, reply, 404, error.code)
          }
          if (error instanceof DatabaseConnectionError) {
            return sendError(request, reply, 502, 'DATABASE_CONNECTION_FAILED')
          }
          throw error
        }
      },
    )
  }

  if (options.sshKnownHostService) {
    const knownHosts = options.sshKnownHostService
    app.post<{ Body: { host: string; port: number } }>(
      '/api/ssh/known-hosts/reset',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['host', 'port'],
            properties: {
              host: { type: 'string', minLength: 1, maxLength: 255 },
              port: { type: 'integer', minimum: 1, maximum: 65_535 },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        await knownHosts.reset(request.body.host, request.body.port, actor.id)
        return reply.code(204).send()
      },
    )
  }

  if (options.databaseExplorer) {
    const explorer = options.databaseExplorer
    const idParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
    } as const
    const schemaParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'schema'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const
    const tableParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'schema', 'table'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        table: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const

    async function browse(
      request: FastifyRequest,
      reply: FastifyReply,
      connectionId: string,
      capability: Extract<WebCapability, 'structure-read' | 'data-read'>,
      action: () => Promise<unknown>,
    ) {
      const user = await authenticate(request, reply)
      if (!user) return
      if (
        options.webAccessService
        && !(await options.webAccessService.can(user, connectionId, capability))
      ) {
        return sendError(request, reply, 403, 'FORBIDDEN')
      }
      try {
        return await action()
      } catch (error) {
        if (error instanceof ConnectionError) {
          return sendError(request, reply, 404, error.code)
        }
        if (error instanceof ExplorerError) {
          return sendError(request, reply, 422, error.code)
        }
        if (error instanceof DatabaseConnectionError) {
          return sendError(request, reply, 502, 'DATABASE_CONNECTION_FAILED')
        }
        throw error
      }
    }

    app.get<{ Params: { id: string } }>(
      '/api/connections/:id/schemas',
      { schema: { params: idParamsSchema } },
      async (request, reply) => browse(
        request,
        reply,
        request.params.id,
        'structure-read',
        () => explorer.listSchemas(request.params.id),
      ),
    )

    app.get<{ Params: { id: string; schema: string } }>(
      '/api/connections/:id/schemas/:schema/tables',
      { schema: { params: schemaParamsSchema } },
      async (request, reply) =>
        browse(
          request,
          reply,
          request.params.id,
          'structure-read',
          () => explorer.listTables(request.params.id, request.params.schema),
        ),
    )

    app.get<{ Params: { id: string; schema: string; table: string } }>(
      '/api/connections/:id/schemas/:schema/tables/:table/columns',
      { schema: { params: tableParamsSchema } },
      async (request, reply) =>
        browse(request, reply, request.params.id, 'structure-read', () =>
          explorer.describeTable(request.params.id, request.params.schema, request.params.table),
        ),
    )

    app.get<{
      Params: { id: string; schema: string; table: string }
      Querystring: { limit?: number; offset?: number }
    }>(
      '/api/connections/:id/schemas/:schema/tables/:table/rows',
      {
        schema: {
          params: tableParamsSchema,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) =>
        browse(request, reply, request.params.id, 'data-read', () =>
          explorer.readRows(
            request.params.id,
            request.params.schema,
            request.params.table,
            request.query,
          ),
        ),
    )
  }

  if (options.queryService) {
    const queryService = options.queryService
    app.post<{ Body: ExecuteQueryInput }>(
      '/api/queries',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['queryId', 'connectionId', 'sql'],
            properties: {
              queryId: {
                type: 'string',
                pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
              },
              connectionId: { type: 'string', minLength: 1, maxLength: 128 },
              sql: { type: 'string', minLength: 1, maxLength: 1_048_576 },
              timeoutMs: { type: 'integer', minimum: 100, maximum: 300_000 },
              rowLimit: { type: 'integer', minimum: 1, maximum: 10_000 },
              confirmedHighRisk: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request, reply)
        if (!user || !validateCsrf(request, reply)) return
        if (
          options.webAccessService
          && !(await options.webAccessService.can(user, request.body.connectionId, 'query-read'))
        ) {
          return sendError(request, reply, 403, 'FORBIDDEN')
        }
        try {
          return options.webAccessService
            ? await queryService.execute(user.id, request.body, { readOnly: user.role !== 'admin' })
            : await queryService.execute(user.id, request.body)
        } catch (error) {
          if (error instanceof ConnectionError) {
            return sendError(request, reply, 404, error.code)
          }
          if (error instanceof QueryError) {
            const statusCode = {
              CONFIRMATION_REQUIRED: 409,
              INVALID_QUERY: 422,
              QUERY_CANCELLED: 409,
              QUERY_FAILED: 502,
              READ_ONLY_QUERY_REQUIRED: 422,
              QUERY_TIMEOUT: 408,
            }[error.code]
            return sendError(request, reply, statusCode, error.code)
          }
          throw error
        }
      },
    )

    app.post<{ Params: { id: string } }>(
      '/api/queries/:id/cancel',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: {
                type: 'string',
                pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request, reply)
        if (!user || !validateCsrf(request, reply)) return
        const cancelled = await queryService.cancel(user.id, request.params.id)
        if (!cancelled) return sendError(request, reply, 404, 'QUERY_NOT_ACTIVE')
        return reply.code(204).send()
      },
    )
  }

  if (options.dataMutationService) {
    const mutationService = options.dataMutationService
    const mutationParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'schema', 'table'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        table: { type: 'string', minLength: 1, maxLength: 128 },
      },
    } as const

    async function handleMutation(
      request: FastifyRequest,
      reply: FastifyReply,
      connectionId: string,
      action: (actor: AuthUser) => Promise<unknown>,
    ) {
      const actor = await authenticate(request, reply)
      if (!actor) return
      const allowed = options.webAccessService
        ? await options.webAccessService.can(actor, connectionId, 'data-write')
        : actor.role === 'admin'
      if (!allowed) return sendError(request, reply, 403, 'FORBIDDEN')
      try {
        return await action(actor)
      } catch (error) {
        if (error instanceof ConnectionError) {
          return sendError(request, reply, 404, error.code)
        }
        if (error instanceof DataMutationError) {
          const statusCode = {
            CONFIRMATION_REQUIRED: 409,
            FORBIDDEN: 403,
            INVALID_MUTATION: 422,
            MUTATION_FAILED: 502,
            ROW_CONFLICT: 409,
            TABLE_WITHOUT_STABLE_KEY: 422,
            UNSUPPORTED_COLUMN: 422,
          }[error.code]
          if (error.code === 'ROW_CONFLICT' && error.operationIndex !== undefined) {
            return reply.code(statusCode).send({
              error: {
                code: error.code,
                message: messages[localeOf(request)][error.code],
                operationIndex: error.operationIndex,
              },
            })
          }
          return sendError(request, reply, statusCode, error.code)
        }
        if (error instanceof DatabaseConnectionError) {
          return sendError(request, reply, 502, 'MUTATION_FAILED')
        }
        throw error
      }
    }

    type MutationParams = { id: string; schema: string; table: string }
    const mutationUrl = '/api/connections/:id/schemas/:schema/tables/:table/mutations'

    app.get<{ Params: MutationParams }>(
      mutationUrl,
      { schema: { params: mutationParamsSchema } },
      async (request, reply) => handleMutation(
        request,
        reply,
        request.params.id,
        (actor) => mutationService.inspect(actor, {
          connectionId: request.params.id,
          schema: request.params.schema,
          table: request.params.table,
        }),
      ),
    )

    app.post<{ Params: MutationParams; Body: Pick<DataMutationRequest, 'operations'> }>(
      mutationUrl,
      {
        schema: {
          params: mutationParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['operations'],
            properties: {
              operations: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        return handleMutation(request, reply, request.params.id, () => mutationService.mutate(actor, {
          connectionId: request.params.id,
          schema: request.params.schema,
          table: request.params.table,
          operations: request.body.operations,
        }))
      },
    )
  }

  if (options.ddlService) {
    const ddlService = options.ddlService
    const ddlParamsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
    } as const
    const ddlKinds: DdlCommand['kind'][] = [
      'create-database', 'rename-database', 'drop-database',
      'create-schema', 'rename-schema', 'drop-schema',
      'create-table', 'rename-table', 'drop-table',
      'add-column', 'rename-column', 'drop-column',
      'create-index', 'drop-index', 'add-constraint', 'drop-constraint',
      'create-view', 'drop-view',
      'create-materialized-view', 'refresh-materialized-view', 'drop-materialized-view',
      'create-sequence', 'drop-sequence',
      'create-enum', 'create-domain', 'drop-type',
      'create-extension', 'drop-extension',
      'create-routine', 'drop-routine',
      'create-trigger', 'drop-trigger',
      'create-event', 'drop-event',
      'create-partition', 'drop-partition',
    ]

    async function handleDdl(
      request: FastifyRequest,
      reply: FastifyReply,
      connectionId: string,
      action: (actor: AuthUser) => Promise<unknown>,
    ) {
      const actor = await authenticate(request, reply)
      if (!actor) return
      const allowed = options.webAccessService
        ? await options.webAccessService.can(actor, connectionId, 'ddl-write')
        : actor.role === 'admin'
      if (!allowed) return sendError(request, reply, 403, 'FORBIDDEN')
      try {
        return await action(actor)
      } catch (error) {
        if (error instanceof ConnectionError) {
          return sendError(request, reply, 404, error.code)
        }
        if (error instanceof DdlValidationError) {
          return sendError(
            request,
            reply,
            error.code === 'DDL_CONFIRMATION_REQUIRED' ? 409 : 422,
            error.code,
          )
        }
        if (error instanceof DdlServiceError) {
          return sendError(request, reply, error.code === 'FORBIDDEN' ? 403 : 502, error.code)
        }
        throw error
      }
    }

    app.get<{ Params: { id: string } }>(
      '/api/connections/:id/ddl/capabilities',
      { schema: { params: ddlParamsSchema } },
      async (request, reply) => handleDdl(
        request,
        reply,
        request.params.id,
        (actor) => ddlService.capabilities(actor, request.params.id),
      ),
    )

    app.post<{ Params: { id: string }; Body: { command: DdlCommand } }>(
      '/api/connections/:id/ddl/execute',
      {
        schema: {
          params: ddlParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
              command: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', enum: ddlKinds } },
                additionalProperties: true,
              },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request, reply)
        if (!actor || !validateCsrf(request, reply)) return
        return handleDdl(request, reply, request.params.id, () => ddlService.execute(actor, {
          connectionId: request.params.id,
          command: request.body.command,
        }))
      },
    )
  }

  if (options.staticRoot) {
    await app.register(staticFiles, {
      root: options.staticRoot,
      wildcard: false,
    })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html', { cacheControl: false })
      }
      return reply.code(404).send({
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
        statusCode: 404,
      })
    })
  }

  return app
}
