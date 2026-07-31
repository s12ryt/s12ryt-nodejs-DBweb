import type { EnvelopeEncryption } from '../security/envelope-encryption.js'
import {
  TransferPreviewError as TransferPreviewTokenError,
  type TransferPreviewFingerprint,
  type TransferPreviewTokenService,
} from './transfer-preview-token.js'

const PREVIEW_TTL_MS = 30 * 60 * 1000
const MAX_PLAN_BYTES = 1024 * 1024

export interface StoredTransferPreviewPlan {
  jobId: string
  encryptedPayload: string
  expiresAt: string
  updatedAt: string
}

export interface TransferPreviewPlanRepository {
  save(plan: StoredTransferPreviewPlan): Promise<void>
  find(jobId: string): Promise<StoredTransferPreviewPlan | undefined>
  deleteExpired(now: string): Promise<number>
}

export type TransferPreviewPlanErrorCode =
  | 'INVALID_PREVIEW_PLAN'
  | 'PREVIEW_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_NOT_FOUND'

export class TransferPreviewPlanError extends Error {
  constructor(readonly code: TransferPreviewPlanErrorCode) {
    super(code)
    this.name = 'TransferPreviewPlanError'
  }
}

interface StoredPayload {
  fingerprint: TransferPreviewFingerprint
  plan: unknown
}

export interface TransferPreviewPlanWriter {
  save(jobId: string, fingerprint: TransferPreviewFingerprint, plan: unknown): Promise<void>
}

export class EncryptedTransferPreviewPlanStore implements TransferPreviewPlanWriter {
  constructor(
    private readonly repository: TransferPreviewPlanRepository,
    private readonly encryption: EnvelopeEncryption,
    private readonly tokens: TransferPreviewTokenService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(jobId: string, fingerprint: TransferPreviewFingerprint, plan: unknown): Promise<void> {
    if (fingerprint.jobId !== jobId || !isJsonValue(plan)) {
      throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
    }
    const serialized = JSON.stringify({ fingerprint, plan } satisfies StoredPayload)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PLAN_BYTES) {
      throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
    }
    const updatedAt = this.now()
    await this.repository.save({
      jobId,
      encryptedPayload: this.encryption.encrypt(serialized, `transfer-preview-plan:${jobId}`),
      expiresAt: new Date(updatedAt.getTime() + PREVIEW_TTL_MS).toISOString(),
      updatedAt: updatedAt.toISOString(),
    })
  }

  async validate(jobId: string, token: string): Promise<unknown> {
    const stored = await this.repository.find(jobId)
    if (!stored) throw new TransferPreviewPlanError('PREVIEW_NOT_FOUND')
    if (this.now().getTime() > Date.parse(stored.expiresAt)) {
      throw new TransferPreviewPlanError('PREVIEW_EXPIRED')
    }

    try {
      const payload = parseStoredPayload(
        this.encryption.decrypt(stored.encryptedPayload, `transfer-preview-plan:${jobId}`),
      )
      if (payload.fingerprint.jobId !== jobId) {
        throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
      }
      this.tokens.verify(token, payload.fingerprint)
      return structuredClone(payload.plan)
    } catch (error) {
      if (error instanceof TransferPreviewPlanError) throw error
      if (error instanceof TransferPreviewTokenError) {
        if (error.code === 'PREVIEW_EXPIRED') throw new TransferPreviewPlanError('PREVIEW_EXPIRED')
        if (error.code === 'PREVIEW_CHANGED') throw new TransferPreviewPlanError('PREVIEW_CHANGED')
      }
      throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
    }
  }
}

export class MemoryTransferPreviewPlanRepository implements TransferPreviewPlanRepository {
  readonly entries: StoredTransferPreviewPlan[] = []

  async save(plan: StoredTransferPreviewPlan): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.jobId === plan.jobId)
    if (index === -1) this.entries.push(structuredClone(plan))
    else this.entries[index] = structuredClone(plan)
  }

  async find(jobId: string): Promise<StoredTransferPreviewPlan | undefined> {
    const found = this.entries.find((entry) => entry.jobId === jobId)
    return found ? structuredClone(found) : undefined
  }

  async deleteExpired(now: string): Promise<number> {
    const retained = this.entries.filter((entry) => entry.expiresAt > now)
    const deleted = this.entries.length - retained.length
    this.entries.splice(0, this.entries.length, ...retained)
    return deleted
  }
}

function parseStoredPayload(serialized: string): StoredPayload {
  const value = JSON.parse(serialized) as unknown
  if (!value || typeof value !== 'object') throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
  const payload = value as Record<string, unknown>
  if (!payload.fingerprint || typeof payload.fingerprint !== 'object' || !isJsonValue(payload.plan)) {
    throw new TransferPreviewPlanError('INVALID_PREVIEW_PLAN')
  }
  return { fingerprint: payload.fingerprint as TransferPreviewFingerprint, plan: payload.plan }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value as Record<string, unknown>).every(isJsonValue)
}
