import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption, EncryptionError } from './envelope-encryption.js'

describe('EnvelopeEncryption', () => {
  const key = Buffer.alloc(32, 1)

  it('使用 AES-256-GCM 加密且不在密文中保留明文', () => {
    const encryption = new EnvelopeEncryption(key)
    const encrypted = encryption.encrypt('database-password', 'connection:abc')

    expect(encrypted).toMatch(/^v1\./)
    expect(encrypted).not.toContain('database-password')
    expect(encryption.decrypt(encrypted, 'connection:abc')).toBe('database-password')
  })

  it('相同明文每次產生不同 nonce 與密文', () => {
    const encryption = new EnvelopeEncryption(key)

    expect(encryption.encrypt('secret', 'connection:abc')).not.toBe(
      encryption.encrypt('secret', 'connection:abc'),
    )
  })

  it('拒絕錯誤用途、錯誤主密鑰及遭篡改的密文', () => {
    const encryption = new EnvelopeEncryption(key)
    const encrypted = encryption.encrypt('secret', 'connection:abc')
    const parts = encrypted.split('.')
    parts[3] = `${parts[3]?.startsWith('A') ? 'B' : 'A'}${parts[3]?.slice(1)}`
    const tampered = parts.join('.')

    expect(() => encryption.decrypt(encrypted, 'audit:abc')).toThrow(EncryptionError)
    expect(() => new EnvelopeEncryption(Buffer.alloc(32, 2)).decrypt(encrypted, 'connection:abc')).toThrow(
      EncryptionError,
    )
    expect(() => encryption.decrypt(tampered, 'connection:abc')).toThrow(EncryptionError)
  })

  it('拒絕不是 256-bit 的主密鑰', () => {
    expect(() => new EnvelopeEncryption(Buffer.alloc(16))).toThrow('MASTER_KEY_INVALID')
  })
})
