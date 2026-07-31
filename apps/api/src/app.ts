import { createHmac, timingSafeEqual } from 'node:crypto'

import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

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
import {
  QueryError,
  type ExecuteQueryInput,
  type SqlQueryService,
} from './query/sql-query-service.js'
import type { SshKnownHostService } from './ssh/ssh-known-host-service.js'

interface BuildAppOptions {
  authService: AuthService
  connectionService?: ConnectionService
  databaseExplorer?: DatabaseExplorer
  dataMutationService?: DataMutationService
  queryService?: SqlQueryService
  sshKnownHostService?: SshKnownHostService
  csrfSecret: Buffer
  production: boolean
  staticRoot?: string
}

interface LoginBody {
  username: string
  password: string
}

interface CreateUserBody extends LoginBody {
  role: UserRole
}

const SESSION_COOKIE = 'dbweb_session'

const messages = {
  en: {
    FORBIDDEN: 'Insufficient permissions',
    CONNECTION_NOT_FOUND: 'Connection not found',
    CONFIRMATION_REQUIRED: 'Confirmation required for high-risk SQL',
    DATABASE_CONNECTION_FAILED: 'Database connection failed',
    INVALID_CONNECTION: 'Invalid connection settings',
    INVALID_KEEPALIVE_INTERVAL: 'Keepalive interval must be between 1 minute and 24 hours',
    INVALID_SSH_CONFIGURATION: 'Invalid SSH configuration',
    INVALID_TLS_CONFIGURATION: 'Invalid TLS configuration',
    INVALID_CREDENTIALS: 'Invalid username or password',
    INVALID_PAGE: 'Invalid page parameters',
    INVALID_QUERY: 'Invalid query parameters',
    INVALID_CSRF: 'Invalid CSRF token',
    INVALID_MUTATION: 'Invalid data mutation',
    INVALID_SESSION: 'Authentication required',
    SESSION_EXPIRED: 'Session expired',
    QUERY_CANCELLED: 'Query cancelled',
    QUERY_FAILED: 'Query execution failed',
    QUERY_NOT_ACTIVE: 'Query is not active',
    QUERY_TIMEOUT: 'Query timed out',
    MUTATION_FAILED: 'Data mutation failed',
    ROW_CONFLICT: 'The row changed or no longer exists',
    TABLE_WITHOUT_STABLE_KEY: 'Table has no stable unique key',
    UNSUPPORTED_COLUMN: 'Column cannot be modified',
    UNAUTHORIZED: 'Authentication required',
    USERNAME_TAKEN: 'Username is already in use',
    WEAK_PASSWORD: 'Password must contain at least 12 characters',
  },
  'zh-TW': {
    FORBIDDEN: '權限不足',
    CONNECTION_NOT_FOUND: '找不到連線設定',
    CONFIRMATION_REQUIRED: '高風險 SQL 需要二次確認',
    DATABASE_CONNECTION_FAILED: '資料庫連線失敗',
    INVALID_CONNECTION: '連線設定無效',
    INVALID_KEEPALIVE_INTERVAL: '保活間隔必須介於 1 分鐘到 24 小時',
    INVALID_SSH_CONFIGURATION: 'SSH 設定無效',
    INVALID_TLS_CONFIGURATION: 'TLS 設定無效',
    INVALID_CREDENTIALS: '使用者名稱或密碼錯誤',
    INVALID_PAGE: '分頁參數無效',
    INVALID_QUERY: '查詢參數無效',
    INVALID_CSRF: 'CSRF 驗證失敗',
    INVALID_MUTATION: '資料異動內容無效',
    INVALID_SESSION: '需要登入',
    SESSION_EXPIRED: '登入階段已過期',
    QUERY_CANCELLED: '查詢已取消',
    QUERY_FAILED: '查詢執行失敗',
    QUERY_NOT_ACTIVE: '查詢未在執行中',
    QUERY_TIMEOUT: '查詢逾時',
    MUTATION_FAILED: '資料異動失敗',
    ROW_CONFLICT: '資料列已變更或不存在',
    TABLE_WITHOUT_STABLE_KEY: '資料表沒有穩定的唯一鍵',
    UNSUPPORTED_COLUMN: '欄位不可修改',
    UNAUTHORIZED: '需要登入',
    USERNAME_TAKEN: '使用者名稱已被使用',
    WEAK_PASSWORD: '密碼至少需要 12 個字元',
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

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | undefined> {
    const token = request.cookies[SESSION_COOKIE]
    if (!token) {
      sendError(request, reply, 401, 'UNAUTHORIZED')
      return undefined
    }

    try {
      return await options.authService.authenticate(token)
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

  app.get('/api/health', async () => ({ status: 'ok' }))

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
    const user = await authenticate(request, reply)
    if (!user) return
    const token = request.cookies[SESSION_COOKIE]
    return {
      user,
      csrfToken: csrfTokenFor(token as string, options.csrfSecret),
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const user = await authenticate(request, reply)
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
          required: ['username', 'password', 'role'],
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
        const user = await options.authService.createUser(request.body)
        return reply.code(201).send(user)
      } catch (error) {
        if (error instanceof AuthError && (error.code === 'USERNAME_TAKEN' || error.code === 'WEAK_PASSWORD')) {
          return sendError(request, reply, 409, error.code)
        }
        throw error
      }
    },
  )

  if (options.connectionService) {
    const connectionService = options.connectionService

    app.get('/api/connections', async (request, reply) => {
      const user = await authenticate(request, reply)
      if (!user) return
      return connectionService.list()
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
      action: () => Promise<unknown>,
    ) {
      const user = await authenticate(request, reply)
      if (!user) return
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
      async (request, reply) => browse(request, reply, () => explorer.listSchemas(request.params.id)),
    )

    app.get<{ Params: { id: string; schema: string } }>(
      '/api/connections/:id/schemas/:schema/tables',
      { schema: { params: schemaParamsSchema } },
      async (request, reply) =>
        browse(request, reply, () => explorer.listTables(request.params.id, request.params.schema)),
    )

    app.get<{ Params: { id: string; schema: string; table: string } }>(
      '/api/connections/:id/schemas/:schema/tables/:table/columns',
      { schema: { params: tableParamsSchema } },
      async (request, reply) =>
        browse(request, reply, () =>
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
        browse(request, reply, () =>
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
        try {
          return await queryService.execute(user.id, request.body)
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
      action: (actor: AuthUser) => Promise<unknown>,
    ) {
      const actor = await authenticate(request, reply)
      if (!actor) return
      if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
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
      async (request, reply) => handleMutation(request, reply, (actor) => mutationService.inspect(actor, {
        connectionId: request.params.id,
        schema: request.params.schema,
        table: request.params.table,
      })),
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
        if (actor.role !== 'admin') return sendError(request, reply, 403, 'FORBIDDEN')
        return handleMutation(request, reply, () => mutationService.mutate(actor, {
          connectionId: request.params.id,
          schema: request.params.schema,
          table: request.params.table,
          operations: request.body.operations,
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
