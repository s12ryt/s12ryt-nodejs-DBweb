import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export class EncryptionError extends Error {
  constructor(message = 'DECRYPTION_FAILED') {
    super(message)
    this.name = 'EncryptionError'
  }
}

export class EnvelopeEncryption {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new EncryptionError('MASTER_KEY_INVALID')
    this.key = Buffer.from(key)
  }

  encrypt(plaintext: string, purpose: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(purpose, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authenticationTag = cipher.getAuthTag()
    return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'), authenticationTag.toString('base64url')].join('.')
  }

  decrypt(envelope: string, purpose: string): string {
    try {
      const [version, nonceValue, ciphertextValue, tagValue, extra] = envelope.split('.')
      if (version !== 'v1' || !nonceValue || !ciphertextValue || !tagValue || extra) {
        throw new Error('invalid envelope')
      }
      const nonce = Buffer.from(nonceValue, 'base64url')
      const ciphertext = Buffer.from(ciphertextValue, 'base64url')
      const authenticationTag = Buffer.from(tagValue, 'base64url')
      if (nonce.length !== 12 || authenticationTag.length !== 16) throw new Error('invalid envelope')

      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
      decipher.setAAD(Buffer.from(purpose, 'utf8'))
      decipher.setAuthTag(authenticationTag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch (error) {
      if (error instanceof EncryptionError) throw error
      throw new EncryptionError()
    }
  }
}
