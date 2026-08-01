import { describe, expect, it, vi } from 'vitest'

import {
  InstanceRoleCoordinator,
  InstanceRoleHealthService,
  MemoryInstanceRoleRepository,
  type InstanceRole,
} from './instance-role-service.js'
import type { HealthService, HealthSnapshot } from './health-service.js'

describe('InstanceRoleCoordinator', () => {
  it('最多選出兩個active，lease到期後讓standby於30秒內晉升', async () => {
    const repository = new MemoryInstanceRoleRepository()
    let now = new Date('2026-08-01T00:00:00.000Z')
    const first = new InstanceRoleCoordinator(repository, 'api-1', { now: () => now })
    const second = new InstanceRoleCoordinator(repository, 'api-2', { now: () => now })
    const standby = new InstanceRoleCoordinator(repository, 'api-3', { now: () => now })

    await first.tick()
    await second.tick()
    await standby.tick()

    expect(first.status().role).toBe('active')
    expect(second.status().role).toBe('active')
    expect(standby.status().role).toBe('standby')

    now = new Date(now.getTime() + 21_000)
    await second.tick()
    await standby.tick()

    expect(standby.status().role).toBe('active')
    expect(standby.status().leaseExpiresAt?.getTime()).toBe(now.getTime() + 20_000)
  })

  it('角色切換依序等待worker啟停，stop會釋放lease', async () => {
    const repository = new MemoryInstanceRoleRepository()
    const changes: string[] = []
    const coordinator = new InstanceRoleCoordinator(repository, 'api-1', {
      onRoleChange: async (role: InstanceRole) => {
        await Promise.resolve()
        changes.push(role)
      },
    })

    await coordinator.start()
    expect(changes).toEqual(['active'])
    await coordinator.stop()
    expect(changes).toEqual(['active', 'standby'])

    const replacement = new InstanceRoleCoordinator(repository, 'api-2')
    await replacement.tick()
    expect(replacement.status().role).toBe('active')
    await replacement.stop()
  })
})

describe('InstanceRoleHealthService', () => {
  it('standby維持liveness但readiness為false，晉升後沿用dependency readiness', async () => {
    const base: HealthService = {
      check: vi.fn(async (): Promise<HealthSnapshot> => ({
        ready: true,
        degraded: false,
        components: { metadata: 'up', objectStorage: 'up', redis: 'up' },
      })),
    }
    let role: InstanceRole = 'standby'
    const health = new InstanceRoleHealthService(base, () => role)

    await expect(health.check()).resolves.toMatchObject({ ready: false, role: 'standby' })
    role = 'active'
    await expect(health.check()).resolves.toMatchObject({ ready: true, role: 'active' })
  })
})
