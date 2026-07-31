import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { AuthService } from '../auth/auth-service.js'
import { MemoryAuthRepository } from '../auth/memory-auth-repository.js'
import {
  MemorySshHostKeyResetRecorder,
  MemorySshKnownHostRepository,
  SshKnownHostService,
} from './ssh-known-host-service.js'

describe('SSH known host HTTP API', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

  async function setup(role: 'admin' | 'user') {
    const auth = new AuthService(new MemoryAuthRepository(), {
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    })
    const actor = await auth.createUser({
      username: role,
      password: 'correct horse battery staple',
      role,
    })
    const repository = new MemorySshKnownHostRepository()
    const recorder = new MemorySshHostKeyResetRecorder()
    const knownHosts = new SshKnownHostService(repository, recorder, () => new Date('2026-07-31T00:00:00.000Z'))
    await knownHosts.verify('ssh.example.test', 2222, 'sha256:old')
    const app = await buildApp({
      authService: auth,
      sshKnownHostService: knownHosts,
      csrfSecret: Buffer.alloc(32, 6),
      production: false,
    })
    apps.push(app)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: role, password: 'correct horse battery staple' },
    })
    return {
      actor,
      app,
      cookie: login.headers['set-cookie'] as string,
      csrfToken: login.json<{ csrfToken: string }>().csrfToken,
      knownHosts,
      recorder,
    }
  }

  it('管理員可重設正規化 endpoint pin 並留下不含 key 的稽核', async () => {
    const { actor, app, cookie, csrfToken, knownHosts, recorder } = await setup('admin')

    const response = await app.inject({
      method: 'POST',
      url: '/api/ssh/known-hosts/reset',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { host: 'SSH.EXAMPLE.TEST.', port: 2222 },
    })

    expect(response.statusCode).toBe(204)
    await expect(knownHosts.verify('ssh.example.test', 2222, 'sha256:new')).resolves.toBeUndefined()
    expect(recorder.events).toEqual([{
      actorId: actor.id,
      endpoint: '[ssh.example.test]:2222',
      createdAt: '2026-07-31T00:00:00.000Z',
    }])
    expect(JSON.stringify(recorder.events)).not.toContain('sha256:')
  })

  it('一般使用者無法重設 pin', async () => {
    const { app, cookie, csrfToken, recorder } = await setup('user')

    const response = await app.inject({
      method: 'POST',
      url: '/api/ssh/known-hosts/reset',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { host: 'ssh.example.test', port: 2222 },
    })

    expect(response.statusCode).toBe(403)
    expect(recorder.events).toEqual([])
  })
})
