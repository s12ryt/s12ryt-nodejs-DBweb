import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const BINARY_MAGIC = Buffer.from('DBW1', 'ascii')
const NONCE_LENGTH = 12
const AUTHENTICATION_TAG_LENGTH = 16

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

  encryptBytes(plaintext: Uint8Array, purpose: string): Buffer {
    const nonce = randomBytes(NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(purpose, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([BINARY_MAGIC, nonce, cipher.getAuthTag(), ciphertext])
  }

  decryptBytes(envelope: Uint8Array, purpose: string): Buffer {
    try {
      const value = Buffer.from(envelope)
      const headerLength = BINARY_MAGIC.length + NONCE_LENGTH + AUTHENTICATION_TAG_LENGTH
      if (value.length < headerLength || !value.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
        throw new Error('invalid binary envelope')
      }
      const nonceStart = BINARY_MAGIC.length
      const tagStart = nonceStart + NONCE_LENGTH
      const ciphertextStart = tagStart + AUTHENTICATION_TAG_LENGTH
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        value.subarray(nonceStart, tagStart),
      )
      decipher.setAAD(Buffer.from(purpose, 'utf8'))
      decipher.setAuthTag(value.subarray(tagStart, ciphertextStart))
      return Buffer.concat([decipher.update(value.subarray(ciphertextStart)), decipher.final()])
    } catch (error) {
      if (error instanceof EncryptionError) throw error
      throw new EncryptionError()
    }
  }
}
