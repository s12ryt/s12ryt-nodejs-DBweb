import type { DatabaseEngine, ResolvedConnection } from '../connections/connection-types.js'

export type NativeAccountIdentity =
  | { engine: 'postgres'; username: string }
  | { engine: 'mysql'; username: string; host: string }

export interface NativeAccountProtectionInput {
  identity: NativeAccountIdentity
  systemAccount: boolean
}

export type NativeAccountProtection =
  | { protected: false }
  | { protected: true; reason: 'connection-account' | 'system-account' }

export class NativeAccountPolicyError extends Error {
  constructor(readonly code: 'INVALID_ACCOUNT_IDENTITY') {
    super(code)
    this.name = 'NativeAccountPolicyError'
  }
}

const MYSQL_HOST_PATTERN = /^[A-Za-z0-9._:%-]+$/

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

export function normalizeNativeAccountIdentity(
  engine: DatabaseEngine,
  input: { username: string; host?: string },
): NativeAccountIdentity {
  const username = input.username.trim()
  if (!username || hasControlCharacter(username)) {
    throw new NativeAccountPolicyError('INVALID_ACCOUNT_IDENTITY')
  }
  if (engine === 'postgres') return { engine, username }

  const host = (input.host ?? '%').trim()
  if (!host || !MYSQL_HOST_PATTERN.test(host)) {
    throw new NativeAccountPolicyError('INVALID_ACCOUNT_IDENTITY')
  }
  return { engine, username, host }
}

export function identityKey(identity: NativeAccountIdentity): string {
  return JSON.stringify(
    identity.engine === 'postgres'
      ? [identity.engine, identity.username]
      : [identity.engine, identity.username, identity.host],
  )
}

export function isProtectedNativeAccount(
  account: NativeAccountProtectionInput,
  connection: ResolvedConnection,
): NativeAccountProtection {
  if (account.systemAccount) return { protected: true, reason: 'system-account' }
  if (account.identity.engine === connection.engine && account.identity.username === connection.username) {
    return { protected: true, reason: 'connection-account' }
  }
  return { protected: false }
}
