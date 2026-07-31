import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryWebAccessRepository, WebAccessService } from '../access/web-access-service.js'
import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import { EncryptedChunkStore } from './encrypted-chunk-store.js'
import { TransferDownloadService } from './transfer-download-service.js'
import {
  MemoryTransferJobRepository,
  TransferJobService,
  transitionTransferJob,
} from './transfer-job.js'
import { TransferUploadService } from './transfer-upload-service.js'

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
    const app = await buildApp({
      authService,
      webAccessService: access,
      transferJobService: jobs,
      transferUploadService: uploads,
      transferDownloadService: downloads,
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
})
