import { createHmac, timingSafeEqual } from 'node:crypto'

const PREVIEW_TTL_MS = 30 * 60 * 1000
const HASH_PATTERN = /^[0-9a-f]{64}$/
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface TransferPreviewFingerprint {
  jobId: string
  sourceChecksum: string
  mappingHash: string
  strategyHash: string
  targetHash: string
  capabilityHash: string
  schemaFingerprint: string
}

interface TransferPreviewPayload extends TransferPreviewFingerprint {
  issuedAt: string
  expiresAt: string
}

export type TransferPreviewErrorCode =
  | 'INVALID_PREVIEW_TOKEN'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_CHANGED'

export class TransferPreviewError extends Error {
  constructor(readonly code: TransferPreviewErrorCode) {
    super(code)
    this.name = 'TransferPreviewError'
  }
}

export class TransferPreviewTokenService {
  constructor(
    private readonly signingKey: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (signingKey.byteLength < 32) throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
  }

  issue(fingerprint: TransferPreviewFingerprint): string {
    this.assertFingerprint(fingerprint)
    const issuedAt = this.now()
    const payload: TransferPreviewPayload = {
      ...fingerprint,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + PREVIEW_TTL_MS).toISOString(),
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `v1.${encoded}.${this.sign(encoded).toString('base64url')}`
  }

  verify(token: string, expected: TransferPreviewFingerprint): TransferPreviewFingerprint {
    this.assertFingerprint(expected)
    const [version, encoded, signature, extra] = token.split('.')
    if (version !== 'v1' || !encoded || !signature || extra !== undefined) {
      throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    }
    const suppliedSignature = this.decodeCanonical(signature)
    const expectedSignature = this.sign(encoded)
    if (
      suppliedSignature.length !== expectedSignature.length
      || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')

    const payload = this.parsePayload(encoded)
    if (this.now().getTime() > Date.parse(payload.expiresAt)) {
      throw new TransferPreviewError('PREVIEW_EXPIRED')
    }
    for (const key of fingerprintKeys) {
      if (payload[key] !== expected[key]) throw new TransferPreviewError('PREVIEW_CHANGED')
    }
    return expected
  }

  private sign(encoded: string): Buffer {
    return createHmac('sha256', this.signingKey).update(`dbweb-transfer-preview-v1.${encoded}`).digest()
  }

  private parsePayload(encoded: string): TransferPreviewPayload {
    try {
      const decoded = this.decodeCanonical(encoded)
      const value = JSON.parse(decoded.toString('utf8')) as unknown
      if (!isPreviewPayload(value)) throw new Error('invalid payload')
      this.assertFingerprint(value)
      if (!Number.isFinite(Date.parse(value.issuedAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
        throw new Error('invalid timestamps')
      }
      return value
    } catch (error) {
      if (error instanceof TransferPreviewError) throw error
      throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    }
  }

  private decodeCanonical(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) {
      throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    }
    return decoded
  }

  private assertFingerprint(value: TransferPreviewFingerprint): void {
    if (!JOB_ID_PATTERN.test(value.jobId)) throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    for (const key of hashKeys) {
      if (!HASH_PATTERN.test(value[key])) throw new TransferPreviewError('INVALID_PREVIEW_TOKEN')
    }
  }
}

const fingerprintKeys = [
  'jobId',
  'sourceChecksum',
  'mappingHash',
  'strategyHash',
  'targetHash',
  'capabilityHash',
  'schemaFingerprint',
] as const satisfies readonly (keyof TransferPreviewFingerprint)[]

const hashKeys = fingerprintKeys.filter(
  (key): key is Exclude<(typeof fingerprintKeys)[number], 'jobId'> => key !== 'jobId',
)

function isPreviewPayload(value: unknown): value is TransferPreviewPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  return fingerprintKeys.every((key) => typeof payload[key] === 'string')
    && typeof payload.issuedAt === 'string'
    && typeof payload.expiresAt === 'string'
}
