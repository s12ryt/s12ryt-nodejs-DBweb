import { describe, expect, it } from 'vitest'

import {
  MemorySshHostKeyResetRecorder,
  MemorySshKnownHostRepository,
  SshHostKeyError,
  SshKnownHostService,
} from './ssh-known-host-service.js'

describe('SshKnownHostService', () => {
  it('以正規化 endpoint 首次固定 SHA-256 指紋，並接受相同 key', async () => {
    const repository = new MemorySshKnownHostRepository()
    const service = new SshKnownHostService(repository, new MemorySshHostKeyResetRecorder())

    await expect(service.verify('DB.EXAMPLE.COM.', 22, 'sha256:first')).resolves.toBeUndefined()
    await expect(service.verify('db.example.com', 22, 'sha256:first')).resolves.toBeUndefined()

    expect(await repository.find('[db.example.com]:22')).toMatchObject({
      endpoint: '[db.example.com]:22',
      fingerprint: 'sha256:first',
    })
  })

  it('拒絕已固定 endpoint 的不同 host key', async () => {
    const service = new SshKnownHostService(
      new MemorySshKnownHostRepository(),
      new MemorySshHostKeyResetRecorder(),
    )
    await service.verify('ssh.internal', 2222, 'sha256:first')

    await expect(service.verify('ssh.internal', 2222, 'sha256:changed')).rejects.toEqual(
      new SshHostKeyError('SSH_HOST_KEY_MISMATCH'),
    )
  })

  it('重設只記錄 endpoint 與操作者，下一次握手可固定新 key', async () => {
    const repository = new MemorySshKnownHostRepository()
    const recorder = new MemorySshHostKeyResetRecorder()
    const service = new SshKnownHostService(repository, recorder, () => new Date('2026-07-31T00:00:00.000Z'))
    await service.verify('ssh.internal', 22, 'sha256:first')

    await service.reset('SSH.INTERNAL', 22, 'admin-1')
    await service.verify('ssh.internal', 22, 'sha256:second')

    expect(recorder.events).toEqual([{
      actorId: 'admin-1',
      endpoint: '[ssh.internal]:22',
      createdAt: '2026-07-31T00:00:00.000Z',
    }])
    expect(JSON.stringify(recorder.events)).not.toContain('sha256:')
    expect(await repository.find('[ssh.internal]:22')).toMatchObject({ fingerprint: 'sha256:second' })
  })
})
