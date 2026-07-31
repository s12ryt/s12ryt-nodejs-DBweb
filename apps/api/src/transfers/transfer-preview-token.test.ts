import { describe, expect, it } from 'vitest'

import {
  TransferPreviewError,
  TransferPreviewTokenService,
  type TransferPreviewFingerprint,
} from './transfer-preview-token.js'

const fingerprint: TransferPreviewFingerprint = {
  jobId: 'de305d54-75b4-431b-adb2-eb6b9e546014',
  sourceChecksum: 'a'.repeat(64),
  mappingHash: 'b'.repeat(64),
  strategyHash: 'c'.repeat(64),
  targetHash: 'd'.repeat(64),
  capabilityHash: 'e'.repeat(64),
  schemaFingerprint: 'f'.repeat(64),
}

describe('TransferPreviewTokenService', () => {
  it('簽發只在30分鐘內有效且綁定完整preview fingerprint的token', () => {
    let now = new Date('2026-07-31T10:00:00.000Z')
    const service = new TransferPreviewTokenService(Buffer.alloc(32, 7), () => now)
    const token = service.issue(fingerprint)

    expect(service.verify(token, fingerprint)).toEqual(fingerprint)
    expect(token).not.toContain(fingerprint.sourceChecksum)

    now = new Date('2026-07-31T10:30:00.001Z')
    expect(() => service.verify(token, fingerprint)).toThrow(
      new TransferPreviewError('PREVIEW_EXPIRED'),
    )
  })

  it('拒絕來源、映射、策略、目標、能力或schema任一變更', () => {
    const service = new TransferPreviewTokenService(Buffer.alloc(32, 8), () =>
      new Date('2026-07-31T10:00:00.000Z'))
    const token = service.issue(fingerprint)

    for (const field of [
      'sourceChecksum',
      'mappingHash',
      'strategyHash',
      'targetHash',
      'capabilityHash',
      'schemaFingerprint',
    ] as const) {
      expect(() => service.verify(token, { ...fingerprint, [field]: '0'.repeat(64) })).toThrow(
        new TransferPreviewError('PREVIEW_CHANGED'),
      )
    }
  })

  it('拒絕竄改、錯誤金鑰、錯誤job及格式不合法的token', () => {
    const now = () => new Date('2026-07-31T10:00:00.000Z')
    const service = new TransferPreviewTokenService(Buffer.alloc(32, 9), now)
    const token = service.issue(fingerprint)
    const other = new TransferPreviewTokenService(Buffer.alloc(32, 10), now)

    expect(() => other.verify(token, fingerprint)).toThrow(
      new TransferPreviewError('INVALID_PREVIEW_TOKEN'),
    )
    expect(() => service.verify(`${token.slice(0, -1)}A`, fingerprint)).toThrow(
      new TransferPreviewError('INVALID_PREVIEW_TOKEN'),
    )
    expect(() => service.verify(token, { ...fingerprint, jobId: crypto.randomUUID() })).toThrow(
      new TransferPreviewError('PREVIEW_CHANGED'),
    )
    expect(() => service.verify('not-a-token', fingerprint)).toThrow(
      new TransferPreviewError('INVALID_PREVIEW_TOKEN'),
    )
  })
})
