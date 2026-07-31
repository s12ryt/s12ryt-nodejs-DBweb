import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'

import { KyselyConnectionRepository } from './kysely-connection-repository.js'
import { createMetadataDatabase, migrateMetadata } from './metadata-database.js'

describe('migrateMetadata', () => {
  it('升級 M1 connections table 並將既有連線正規化為停用 SSH', async () => {
    const database = createMetadataDatabase({ kind: 'sqlite', filename: ':memory:' })
    try {
      await sql`CREATE TABLE connections (
        id varchar(36) PRIMARY KEY,
        name varchar(128) NOT NULL,
        engine varchar(16) NOT NULL,
        host varchar(255) NOT NULL,
        port integer NOT NULL,
        database_name varchar(128) NOT NULL,
        username varchar(128) NOT NULL,
        tls_mode varchar(16) NOT NULL,
        tls_has_ca integer NOT NULL,
        tls_has_client_certificate integer NOT NULL,
        keepalive_enabled integer NOT NULL,
        keepalive_interval_ms integer NOT NULL,
        created_by varchar(36) NOT NULL,
        created_at varchar(35) NOT NULL,
        encrypted_secrets text NOT NULL
      )`.execute(database)
      await sql`INSERT INTO connections VALUES (
        'connection-1', 'Legacy', 'postgres', 'localhost', 5432, 'app', 'reader',
        'disable', 0, 0, 0, 300000, 'admin-1', '2026-07-31T00:00:00.000Z', 'ciphertext'
      )`.execute(database)

      await migrateMetadata(database)

      const metadata = await database.introspection.getTables()
      const connections = metadata.find((table) => table.name === 'connections')
      expect(connections?.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'ssh_enabled',
        'ssh_host',
        'ssh_port',
        'ssh_username',
      ]))
      await expect(new KyselyConnectionRepository(database).findById('connection-1'))
        .resolves.toMatchObject({ ssh: { enabled: false } })
    } finally {
      await database.destroy()
    }
  })
})
