import type { ResolvedConnection } from '../connections/connection-types.js'
import type { NativeAccountIdentity } from './native-account-policy.js'
import type { NativeGrantChange } from './native-grant-plan.js'

export class NativeGrantGatewayError extends Error {
  constructor(
    readonly code: 'NATIVE_GRANT_FAILED',
    readonly appliedCount: number,
    readonly failedIndex: number,
  ) {
    super(code)
    this.name = 'NativeGrantGatewayError'
  }
}

export interface NativeGrantGateway {
  listGrants(
    connection: ResolvedConnection,
    targetDatabase: string,
    identity: NativeAccountIdentity,
  ): Promise<NativeGrantChange[]>
  execute(
    connection: ResolvedConnection,
    targetDatabase: string,
    statements: string[],
  ): Promise<{ appliedCount: number }>
}
