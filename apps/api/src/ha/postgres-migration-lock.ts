import { sql } from 'kysely'

import type { MetadataKysely } from '../metadata/metadata-database.js'

const METADATA_MIGRATION_LOCK = 'dbweb-metadata-migration-v1'

export interface PostgresMigrationLockSession {
  lock(name: string): Promise<void>
  unlock(name: string): Promise<void>
}

export interface PostgresMigrationSessionProvider {
  withSession(run: (session: PostgresMigrationLockSession) => Promise<void>): Promise<void>
}

export class PostgresMigrationLock {
  constructor(private readonly sessions: PostgresMigrationSessionProvider) {}

  run(migration: () => Promise<void>): Promise<void> {
    return this.sessions.withSession(async (session) => {
      await session.lock(METADATA_MIGRATION_LOCK)
      let migrationError: unknown
      try {
        await migration()
      } catch (error) {
        migrationError = error
      }
      let unlockError: unknown
      try {
        await session.unlock(METADATA_MIGRATION_LOCK)
      } catch (error) {
        unlockError = error
      }
      if (migrationError) throw migrationError
      if (unlockError) throw unlockError
    })
  }
}

export class KyselyPostgresMigrationSessionProvider implements PostgresMigrationSessionProvider {
  constructor(private readonly database: MetadataKysely) {}

  withSession(run: (session: PostgresMigrationLockSession) => Promise<void>): Promise<void> {
    return this.database.connection().execute(async (connection) => run({
      lock: async (name) => {
        await sql`SELECT pg_advisory_lock(hashtext(${name}))`.execute(connection)
      },
      unlock: async (name) => {
        await sql`SELECT pg_advisory_unlock(hashtext(${name}))`.execute(connection)
      },
    }))
  }
}
