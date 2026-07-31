import { randomBytes } from 'node:crypto'

import type { EnvelopeEncryption } from '../security/envelope-encryption.js'

export class NativeAccountCredentialError extends Error {
  constructor(readonly code: 'WEAK_NATIVE_ACCOUNT_PASSWORD') {
    super(code)
    this.name = 'NativeAccountCredentialError'
  }
}

export interface SealedNativeAccountCredential {
  password: string
  encryptedPassword: string
}

export class NativeAccountCredentialVault {
  constructor(private readonly encryption: EnvelopeEncryption) {}

  seal(accountId: string, suppliedPassword?: string): SealedNativeAccountCredential {
    const password = suppliedPassword ?? randomBytes(24).toString('base64url')
    if (password.length < 16) {
      throw new NativeAccountCredentialError('WEAK_NATIVE_ACCOUNT_PASSWORD')
    }
    return {
      password,
      encryptedPassword: this.encryption.encrypt(password, this.purpose(accountId)),
    }
  }

  reveal(accountId: string, encryptedPassword: string): string {
    return this.encryption.decrypt(encryptedPassword, this.purpose(accountId))
  }

  private purpose(accountId: string): string {
    return `native-account:${accountId}`
  }
}
