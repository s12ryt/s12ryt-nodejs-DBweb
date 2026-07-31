import { describe, expect, it } from 'vitest'

import { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  NativeAccountCredentialError,
  NativeAccountCredentialVault,
} from './native-account-credential.js'

describe('NativeAccountCredentialVault', () => {
  it('generates a 32-character password and encrypts it for one account only', () => {
    const vault = new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 7)))
    const sealed = vault.seal('account-1')

    expect(sealed.password).toHaveLength(32)
    expect(sealed.encryptedPassword).not.toContain(sealed.password)
    expect(vault.reveal('account-1', sealed.encryptedPassword)).toBe(sealed.password)
    expect(() => vault.reveal('account-2', sealed.encryptedPassword)).toThrow()
  })

  it('accepts manual passwords of at least 16 characters and rejects weaker values', () => {
    const vault = new NativeAccountCredentialVault(new EnvelopeEncryption(Buffer.alloc(32, 8)))
    expect(vault.seal('account-1', 'sixteen-chars-ok!').password).toBe('sixteen-chars-ok!')
    expect(() => vault.seal('account-1', 'too-short')).toThrow(
      new NativeAccountCredentialError('WEAK_NATIVE_ACCOUNT_PASSWORD'),
    )
  })
})
