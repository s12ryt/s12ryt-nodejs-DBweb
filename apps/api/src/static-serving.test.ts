import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.js'
import { AuthService } from './auth/auth-service.js'
import { MemoryAuthRepository } from './auth/memory-auth-repository.js'

describe('static web application serving', () => {
  const apps: FastifyInstance[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
    await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true })))
  })

  it('serves built assets and falls back to index.html only for non-API GET routes', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'dbweb-static-'))
    directories.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>DBWeb shell</title>')
    await writeFile(join(staticRoot, 'app.js'), 'globalThis.DBWEB_LOADED = true')
    const app = await buildApp({
      authService: new AuthService(new MemoryAuthRepository(), {
        idleTimeoutMs: 30 * 60_000,
        absoluteTimeoutMs: 12 * 60 * 60_000,
        passwordHashOptions: { memoryCost: 1024, timeCost: 1 },
      }),
      csrfSecret: Buffer.alloc(32, 1),
      production: true,
      staticRoot,
    })
    apps.push(app)

    const index = await app.inject({ method: 'GET', url: '/' })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.body).toContain('DBWeb shell')
    expect(index.headers['content-security-policy']).not.toContain('upgrade-insecure-requests')

    const asset = await app.inject({ method: 'GET', url: '/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.body).toContain('DBWEB_LOADED')

    const spaRoute = await app.inject({ method: 'GET', url: '/connections/local' })
    expect(spaRoute.statusCode).toBe(200)
    expect(spaRoute.body).toContain('DBWeb shell')

    const missingApi = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(missingApi.statusCode).toBe(404)
    expect(missingApi.headers['content-type']).toContain('application/json')
  }, 15_000)
})
