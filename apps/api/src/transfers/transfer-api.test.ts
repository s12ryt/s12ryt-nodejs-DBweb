import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import { MemoryWebAccessRepository, WebAccessService } from '../access/web-access-service.js'
import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { ExactCsvExportError } from './exact-csv-export-service.js'
import { ExactCsvPreviewError } from './exact-csv-preview.js'
import { ExactJsonExportError } from './exact-json-export-service.js'
import { TransferDownloadService } from './transfer-download-service.js'
import { TransferHandlerRouter } from './transfer-handler-router.js'
import {
  MemoryTransferJobRepository,
  type StoredTransferJob,
  TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import { TransferUploadService } from './transfer-upload-service.js'
import type { TransferPreviewService } from './transfer-preview-service.js'

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('transfer HTTP API', () => {
  const apps: FastifyInstance[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
    await Promise.all(directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ))
  })

  async function setup() {
    const authService = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const adminUser = await authService.createUser({
      username: 'admin', password: 'admin-password-value', role: 'admin',
    })
    const operatorUser = await authService.createUser({
      username: 'operator', password: 'operator-password-value', role: 'user',
    })
    const access = new WebAccessService(new MemoryWebAccessRepository())
    const repository = new MemoryTransferJobRepository()
    const authorize = async (
      actor: { id: string; role: 'admin' | 'user' },
      input: { connectionId: string; direction: 'import' | 'export'; format: 'csv' | 'json' | 'sql'; includeData?: boolean },
    ) => {
      if (actor.role === 'admin') return true
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
    const jobs = new TransferJobService(repository, authorize)
    const root = await mkdtemp(join(tmpdir(), 'dbweb-transfer-api-'))
    directories.push(root)
    const uploads = new TransferUploadService(
      jobs,
      new EncryptedChunkStore({
        root,
        encryption: new EnvelopeEncryption(Buffer.alloc(32, 4)),
      }),
      8 * 1024 * 1024,
      () => new Date('2026-07-31T00:05:00.000Z'),
      async (actor, job) => access.can(actor, job.connectionId, 'data-write'),
    )
    const output = new EncryptedChunkStore({
      root: join(root, 'output'),
      encryption: new EnvelopeEncryption(Buffer.alloc(32, 4)),
      purposeNamespace: 'output',
    })
    const downloads = new TransferDownloadService(
      jobs,
      output,
      async (actor, job) => access.can(actor, job.connectionId, 'data-read'),
    )
    const preview = vi.fn(async () => ({
      token: 'v1.preview-token.signature',
      estimatedBytes: 64,
      estimatedRows: 2,
      estimatedTables: 1,
      issues: [],
    }))
    const execute = vi.fn(async () => ({
      bytes: 64,
      checksum: sha256(Buffer.from('csv-output')),
      chunks: [{ index: 0, size: 64, checksum: sha256(Buffer.from('csv-output')) }],
    }))
    const cancelExport = vi.fn((actor, jobId: string) => jobs.cancel(actor, jobId))
    const executionHandler = {
      inspect: vi.fn(async () => ({
        fingerprint: {} as never, estimatedBytes: 0, estimatedRows: 0, estimatedTables: 0, issues: [], plan: {},
      })),
      execute,
      cancel: cancelExport,
    }
    const transferExecutionService = new TransferHandlerRouter(jobs, {
      friendlyCsvExport: executionHandler,
      exactJsonExport: executionHandler,
      exactJsonImport: executionHandler,
    })
    const app = await buildApp({
      authService,
      webAccessService: access,
      transferJobService: jobs,
      transferUploadService: uploads,
      transferDownloadService: downloads,
      transferPreviewService: { preview } as unknown as TransferPreviewService,
      transferExecutionService,
      csrfSecret: Buffer.alloc(32, 5),
      production: false,
    })
    apps.push(app)

    async function login(username: string, password: string) {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username, password },
      })
      return {
        cookie: response.headers['set-cookie'] as string,
        csrf: response.json<{ csrfToken: string }>().csrfToken,
      }
    }
    return {
      access,
      adminUser,
      app,
      operator: await login('operator', 'operator-password-value'),
      operatorUser,
      jobs,
      output,
      preview,
      execute,
    }
  }

  it('建立者可分段上傳、查詢進度、完成整檔驗證及取消job', async () => {
    const environment = await setup()
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
    }
    const createUrl = '/api/transfers'
    expect((await environment.app.inject({
      method: 'POST', url: createUrl, headers,
      payload: { connectionId: 'connection-1', direction: 'import', format: 'json' },
    })).statusCode).toBe(403)

    await environment.access.assign(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
      ['data-write'],
    )
    const created = await environment.app.inject({
      method: 'POST', url: createUrl, headers,
      payload: { connectionId: 'connection-1', direction: 'import', format: 'json' },
    })
    expect(created.statusCode).toBe(201)
    const jobId = created.json<{ id: string }>().id
    const content = Buffer.from('portable-transfer')

    const uploaded = await environment.app.inject({
      method: 'PUT',
      url: `/api/transfers/${jobId}/chunks/0`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': sha256(content),
      },
      payload: content,
    })
    expect(uploaded.statusCode).toBe(200)
    expect(uploaded.json()).toMatchObject({ index: 0, size: content.length })

    const chunks = await environment.app.inject({
      method: 'GET', url: `/api/transfers/${jobId}/chunks`, headers,
    })
    expect(chunks.json()).toEqual([expect.objectContaining({ index: 0, size: content.length })])

    const completed = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/upload-complete`, headers,
      payload: { size: content.length, checksum: sha256(content) },
    })
    expect(completed.statusCode).toBe(200)
    expect(completed.json()).toMatchObject({
      id: jobId,
      sourceBytes: content.length,
      sourceChecksum: sha256(content),
    })
    expect((await environment.app.inject({
      method: 'GET', url: '/api/transfers', headers,
    })).json()).toHaveLength(1)

    const cancelled = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/cancel`, headers, payload: {},
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' })
  })

  it('撤銷能力後下一個chunk立即被拒絕，但建立者仍可查看並取消job', async () => {
    const environment = await setup()
    await environment.access.assign(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
      ['data-write'],
    )
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
    }
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'import', format: 'csv' },
    })
    const jobId = created.json<{ id: string }>().id
    await environment.access.revoke(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
    )
    const content = Buffer.from('blocked')

    expect((await environment.app.inject({
      method: 'PUT', url: `/api/transfers/${jobId}/chunks/0`,
      headers: {
        ...headers, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(content),
      },
      payload: content,
    })).statusCode).toBe(403)
    expect((await environment.app.inject({
      method: 'GET', url: `/api/transfers/${jobId}`, headers,
    })).statusCode).toBe(200)
    expect((await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/cancel`, headers, payload: {},
    })).statusCode).toBe(200)
  })

  it('以串流attachment下載成功輸出，並於能力撤銷後立即拒絕', async () => {
    const environment = await setup()
    await environment.access.assign(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
      ['data-read'],
    )
    const job = await environment.jobs.create(environment.operatorUser, {
      connectionId: 'connection-1', direction: 'export', format: 'json',
    })
    await environment.jobs.update(environment.operatorUser, job.id, (current) =>
      transitionTransferJob(current, 'previewed', { updatedAt: current.updatedAt }))
    await environment.jobs.update(environment.operatorUser, job.id, (current) =>
      transitionTransferJob(current, 'running', { updatedAt: current.updatedAt }))
    await environment.jobs.update(environment.operatorUser, job.id, (current) =>
      transitionTransferJob(current, 'succeeded', { updatedAt: current.updatedAt }))
    const content = Buffer.from('download-result')
    await environment.output.put(job.id, 0, content, sha256(content))
    const headers = { cookie: environment.operator.cookie }

    const response = await environment.app.inject({
      method: 'GET', url: `/api/transfers/${job.id}/download`, headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-length']).toBe(String(content.length))
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${job.id}.json"`)
    expect(response.rawPayload).toEqual(content)

    await environment.access.revoke(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
    )
    expect((await environment.app.inject({
      method: 'GET', url: `/api/transfers/${job.id}/download`, headers,
    })).statusCode).toBe(403)
  })

  it('以伺服器preview計畫執行friendly CSV export', async () => {
    const environment = await setup()
    await environment.access.assign(
      environment.adminUser,
      environment.operatorUser.id,
      'connection-1',
      ['data-read'],
    )
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
    }
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'export', format: 'csv' },
    })
    const jobId = created.json<{ id: string }>().id
    const request = {
      mapping: {},
      strategy: { mode: 'friendly', delimiter: ',', bom: true, rawFormulaValues: false },
      target: { schema: 'public', table: 'orders', filters: [] },
    }

    const previewed = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/preview`, headers, payload: request,
    })
    expect(previewed.statusCode).toBe(200)
    expect(previewed.json()).toMatchObject({ token: 'v1.preview-token.signature', estimatedRows: 2 })
    expect(environment.preview).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.operatorUser.id }),
      jobId,
      request,
    )

    const executed = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/execute`, headers,
      payload: { previewToken: 'v1.preview-token.signature' },
    })
    expect(executed.statusCode).toBe(200)
    expect(executed.json()).toMatchObject({ bytes: 64 })
    expect(environment.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.operatorUser.id }),
      jobId,
      'v1.preview-token.signature',
    )
  })

  it('拒絕尚未支援的傳輸方向與格式，不fallback至其他handler', async () => {
    const environment = await setup()
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
    }
    await environment.access.assign(environment.adminUser, environment.operatorUser.id, 'connection-1', ['data-write'])
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'import', format: 'csv' },
    })
    const jobId = created.json<StoredTransferJob>().id
    const response = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/execute`, headers,
      payload: { previewToken: 'v1.preview-token.signature' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_TRANSFER_HANDLER' } })
    expect(environment.execute).not.toHaveBeenCalled()
  })

  it('不洩露精確JSON匯出的底層失敗', async () => {
    const environment = await setup()
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
    }
    await environment.access.assign(environment.adminUser, environment.operatorUser.id, 'connection-1', ['data-read'])
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'export', format: 'json' },
    })
    const jobId = created.json<StoredTransferJob>().id
    environment.execute.mockRejectedValueOnce(new ExactJsonExportError('EXPORT_FAILED'))
    const response = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/execute`,
      headers: { ...headers, 'accept-language': 'en' },
      payload: { previewToken: 'v1.preview-token.signature' },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: { code: 'EXPORT_FAILED', message: 'Transfer export failed' } })
  })

  it('將精確CSV preview驗證錯誤映射為安全回應', async () => {
    const environment = await setup()
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
      'accept-language': 'en',
    }
    await environment.access.assign(environment.adminUser, environment.operatorUser.id, 'connection-1', ['data-read'])
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'export', format: 'csv' },
    })
    const jobId = created.json<StoredTransferJob>().id

    environment.preview.mockRejectedValueOnce(new ExactCsvPreviewError('INVALID_PREVIEW'))
    const invalid = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/preview`, headers,
      payload: { mapping: {}, strategy: { mode: 'exact' }, target: {} },
    })
    expect(invalid.statusCode).toBe(422)
    expect(invalid.json()).toEqual({
      error: { code: 'INVALID_PREVIEW', message: 'Transfer preview settings are invalid' },
    })

    environment.preview.mockRejectedValueOnce(new ExactCsvPreviewError('CONFIRMATION_REQUIRED'))
    const unconfirmed = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/preview`, headers,
      payload: { mapping: {}, strategy: { mode: 'exact' }, target: {} },
    })
    expect(unconfirmed.statusCode).toBe(409)
    expect(unconfirmed.json()).toEqual({
      error: { code: 'TRANSFER_CONFIRMATION_REQUIRED', message: 'Transfer operation requires confirmation' },
    })
  })

  it('不洩露精確CSV匯出的底層失敗', async () => {
    const environment = await setup()
    const headers = {
      cookie: environment.operator.cookie,
      'x-csrf-token': environment.operator.csrf,
      'accept-language': 'en',
    }
    await environment.access.assign(environment.adminUser, environment.operatorUser.id, 'connection-1', ['data-read'])
    const created = await environment.app.inject({
      method: 'POST', url: '/api/transfers', headers,
      payload: { connectionId: 'connection-1', direction: 'export', format: 'csv' },
    })
    const jobId = created.json<StoredTransferJob>().id
    environment.execute.mockRejectedValueOnce(new ExactCsvExportError('EXPORT_FAILED'))

    const response = await environment.app.inject({
      method: 'POST', url: `/api/transfers/${jobId}/execute`, headers,
      payload: { previewToken: 'v1.preview-token.signature' },
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: { code: 'EXPORT_FAILED', message: 'Transfer export failed' } })
  })
})
