import {
  identityKey,
  type NativeAccountIdentity,
} from '../accounts/native-account-policy.js'
import type {
  NativeAccountRepository,
  StoredNativeAccount,
} from '../accounts/native-account-service.js'
import type { MetadataDatabase, MetadataKysely } from './metadata-database.js'

type NativeAccountRow = MetadataDatabase['managed_native_accounts']

export class KyselyNativeAccountRepository implements NativeAccountRepository {
  constructor(private readonly database: MetadataKysely) {}

  async findById(id: string): Promise<StoredNativeAccount | undefined> {
    const row = await this.database
      .selectFrom('managed_native_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? this.map(row) : undefined
  }

  async findByIdentity(
    connectionId: string,
    identity: NativeAccountIdentity,
  ): Promise<StoredNativeAccount | undefined> {
    const row = await this.database
      .selectFrom('managed_native_accounts')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('identity_key', '=', identityKey(identity))
      .executeTakeFirst()
    return row ? this.map(row) : undefined
  }

  async listByConnection(connectionId: string): Promise<StoredNativeAccount[]> {
    const rows = await this.database
      .selectFrom('managed_native_accounts')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('username')
      .orderBy('host')
      .execute()
    return rows.map((row) => this.map(row))
  }

  async listDue(now: string): Promise<StoredNativeAccount[]> {
    const rows = await this.database
      .selectFrom('managed_native_accounts')
      .selectAll()
      .where('status', '!=', 'deleted')
      .where((expression) => expression.or([
        expression('retry_verification_at', '<=', now),
        expression.and([
          expression('retry_verification_at', 'is', null),
          expression('next_verification_at', '<=', now),
        ]),
      ]))
      .orderBy('connection_id')
      .orderBy('next_verification_at')
      .execute()
    return rows.map((row) => this.map(row))
  }

  async deleteExpiredRecovery(now: string): Promise<number> {
    const result = await this.database
      .deleteFrom('managed_native_accounts')
      .where('status', '=', 'deleted')
      .where('recover_until', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  async save(account: StoredNativeAccount): Promise<void> {
    const values = this.values(account)
    await this.database
      .insertInto('managed_native_accounts')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['connection_id', 'identity_key']).doUpdateSet({
          encrypted_password: values.encrypted_password,
          verification_database: values.verification_database,
          verification_interval_ms: values.verification_interval_ms,
          can_login: values.can_login,
          connection_limit: values.connection_limit,
          status: values.status,
          verification_failures: values.verification_failures,
          next_verification_at: values.next_verification_at,
          last_verified_at: values.last_verified_at,
          retry_verification_at: values.retry_verification_at,
          deleted_at: values.deleted_at,
          recover_until: values.recover_until,
          updated_at: values.updated_at,
        }),
      )
      .execute()
  }

  private values(account: StoredNativeAccount): NativeAccountRow {
    return {
      id: account.id,
      connection_id: account.connectionId,
      identity_key: identityKey(account.identity),
      engine: account.identity.engine,
      username: account.identity.username,
      host: account.identity.engine === 'mysql' ? account.identity.host : null,
      encrypted_password: account.encryptedPassword,
      verification_database: account.verificationDatabase,
      verification_interval_ms: account.verificationIntervalMs,
      can_login: account.canLogin ? 1 : 0,
      connection_limit: account.connectionLimit,
      status: account.status,
      verification_failures: account.verificationFailures,
      next_verification_at: account.nextVerificationAt,
      last_verified_at: account.lastVerifiedAt ?? null,
      retry_verification_at: account.retryVerificationAt ?? null,
      deleted_at: account.deletedAt ?? null,
      recover_until: account.recoverUntil ?? null,
      created_at: account.createdAt,
      updated_at: account.updatedAt,
    }
  }

  private map(row: NativeAccountRow): StoredNativeAccount {
    const identity: NativeAccountIdentity = row.engine === 'mysql'
      ? { engine: 'mysql', username: row.username, host: row.host ?? '%' }
      : { engine: 'postgres', username: row.username }
    return {
      id: row.id,
      connectionId: row.connection_id,
      identity,
      encryptedPassword: row.encrypted_password,
      verificationDatabase: row.verification_database,
      verificationIntervalMs: row.verification_interval_ms,
      canLogin: Boolean(row.can_login),
      connectionLimit: row.connection_limit,
      status: row.status,
      verificationFailures: row.verification_failures,
      nextVerificationAt: row.next_verification_at,
      ...(row.last_verified_at ? { lastVerifiedAt: row.last_verified_at } : {}),
      ...(row.retry_verification_at ? { retryVerificationAt: row.retry_verification_at } : {}),
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      ...(row.recover_until ? { recoverUntil: row.recover_until } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
