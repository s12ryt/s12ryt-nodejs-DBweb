import { describe, expect, it } from 'vitest'

import type { AuthUser } from '../auth/auth-types.js'
import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  EncryptedSecurityAuditRecorder,
  MemorySecurityAuditRepository,
} from '../security/security-audit.js'
import {
  AccessControlError,
  MemoryWebAccessRepository,
  WebAccessService,
  type WebCapability,
} from './web-access-service.js'

const admin: AuthUser = {
  id: 'admin-1',
  username: 'admin',
  role: 'admin',
  enabled: true,
  passwordChangeRequired: false,
}
const operator: AuthUser = {
  id: 'user-1',
  username: 'operator',
  role: 'user',
  enabled: true,
  passwordChangeRequired: false,
}

describe('WebAccessService', () => {
  it('新分配預設為唯讀三能力，未分配連線不可見', async () => {
    const service = new WebAccessService(new MemoryWebAccessRepository())

    expect(await service.can(operator, 'connection-1', 'structure-read')).toBe(false)
    expect(await service.listVisibleConnectionIds(operator)).toEqual([])

    const assignment = await service.assign(admin, operator.id, 'connection-1')

    expect(assignment.capabilities).toEqual([
      'structure-read',
      'data-read',
      'query-read',
    ])
    expect(await service.listVisibleConnectionIds(operator)).toEqual(['connection-1'])
    expect(await service.can(operator, 'connection-1', 'data-read')).toBe(true)
    expect(await service.can(operator, 'connection-1', 'data-write')).toBe(false)
  })

  it('自動補齊能力相依並保持帳號管理獨立', async () => {
    const service = new WebAccessService(new MemoryWebAccessRepository())

    const assignment = await service.assign(admin, operator.id, 'connection-1', [
      'data-write',
      'ddl-write',
      'account-manage',
    ])

    expect(new Set(assignment.capabilities)).toEqual(
      new Set<WebCapability>([
        'structure-read',
        'data-read',
        'data-write',
        'ddl-write',
        'account-manage',
      ]),
    )
    expect(assignment.capabilities).not.toContain('query-read')
  })

  it('管理員不需分配即擁有全部能力，且只有管理員可配置', async () => {
    const service = new WebAccessService(new MemoryWebAccessRepository())

    expect(await service.can(admin, 'unknown-connection', 'ddl-write')).toBe(true)
    await expect(
      service.assign(operator, operator.id, 'connection-1', ['structure-read']),
    ).rejects.toEqual(new AccessControlError('FORBIDDEN'))
  })

  it('每次檢查即時讀取repository，撤銷後下一請求立即失效', async () => {
    const repository = new MemoryWebAccessRepository()
    const service = new WebAccessService(repository)
    await service.assign(admin, operator.id, 'connection-1', ['data-read'])

    expect(await service.can(operator, 'connection-1', 'data-read')).toBe(true)

    await service.revoke(admin, operator.id, 'connection-1')

    expect(await service.can(operator, 'connection-1', 'data-read')).toBe(false)
    expect(await service.listVisibleConnectionIds(operator)).toEqual([])
  })

  it('只有管理員可列出指定使用者的assignments', async () => {
    const repository = new MemoryWebAccessRepository()
    const service = new WebAccessService(repository)
    await service.assign(admin, operator.id, 'connection-1', ['query-read'])

    await expect(service.listAssignments(admin, operator.id)).resolves.toEqual([
      { userId: operator.id, connectionId: 'connection-1', capabilities: ['query-read'] },
    ])
    await expect(service.listAssignments(operator, operator.id)).rejects.toEqual(
      new AccessControlError('FORBIDDEN'),
    )
  })

  it('配置與撤銷Web能力皆寫入365天安全稽核', async () => {
    const auditRepository = new MemorySecurityAuditRepository()
    const service = new WebAccessService(
      new MemoryWebAccessRepository(),
      new EncryptedSecurityAuditRecorder(
        auditRepository,
        new EnvelopeEncryption(Buffer.alloc(32, 62)),
      ),
    )

    await service.assign(admin, operator.id, 'connection-1', ['data-write'])
    await service.revoke(admin, operator.id, 'connection-1')

    expect((await auditRepository.list()).map((event) => event.action)).toEqual([
      'web-access-assign',
      'web-access-revoke',
    ])
  })
})
