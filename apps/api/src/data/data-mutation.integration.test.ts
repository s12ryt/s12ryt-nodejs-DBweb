import mysql from 'mysql2/promise'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import type { ResolvedConnection } from '../connections/connection-types.js'
import { DataMutationError, type DataMutationGateway } from './data-mutation-service.js'
import { MysqlDataMutationGateway } from './mysql-data-mutation-gateway.js'
import { PostgresDataMutationGateway } from './postgres-data-mutation-gateway.js'

const engine = process.env.DBWEB_INTEGRATION_ENGINE
const host = process.env.DBWEB_INTEGRATION_HOST ?? '127.0.0.1'
const port = Number(process.env.DBWEB_INTEGRATION_PORT ?? (engine === 'mysql' ? 3306 : 5432))
const database = process.env.DBWEB_INTEGRATION_DATABASE ?? 'dbweb'
const username = process.env.DBWEB_INTEGRATION_USERNAME ?? 'dbweb'
const password = process.env.DBWEB_INTEGRATION_PASSWORD ?? 'dbweb-test-password'

const connection: ResolvedConnection = {
  id: 'integration',
  name: 'Integration database',
  engine: engine === 'mysql' ? 'mysql' : 'postgres',
  host,
  port,
  database,
  username,
  password,
  tls: { mode: 'disable' },
  keepAlive: { enabled: false, intervalMs: 300_000 },
  ssh: { enabled: false },
}

describe.runIf(engine === 'postgres')('PostgreSQL data mutation integration', () => {
  verifyDialect(new PostgresDataMutationGateway(), 'public', {
    setup: async () => {
      const client = new Client({ host, port, database, user: username, password })
      await client.connect()
      await client.query('DROP TABLE IF EXISTS dbweb_mutation_test')
      await client.query('CREATE TABLE dbweb_mutation_test (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, amount NUMERIC(12,2) NOT NULL)')
      await client.end()
    },
    query: async (sql, values = []) => {
      const client = new Client({ host, port, database, user: username, password })
      await client.connect()
      try { return (await client.query(sql, values)).rows as Array<Record<string, unknown>> }
      finally { await client.end() }
    },
    cleanup: async () => {
      const client = new Client({ host, port, database, user: username, password })
      await client.connect()
      try { await client.query('DROP TABLE IF EXISTS dbweb_mutation_test') }
      finally { await client.end() }
    },
    selectSql: 'SELECT id, name, amount FROM dbweb_mutation_test ORDER BY id',
    externalUpdateSql: 'UPDATE dbweb_mutation_test SET name = $1 WHERE id = $2',
  })
})

describe.runIf(engine === 'mysql')('MySQL data mutation integration', () => {
  verifyDialect(new MysqlDataMutationGateway(), database, {
    setup: async () => {
      const client = await mysql.createConnection({ host, port, database, user: username, password })
      await client.query('DROP TABLE IF EXISTS dbweb_mutation_test')
      await client.query('CREATE TABLE dbweb_mutation_test (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, amount DECIMAL(12,2) NOT NULL) ENGINE=InnoDB')
      await client.end()
    },
    query: async (sql, values = []) => {
      const client = await mysql.createConnection({ host, port, database, user: username, password })
      try {
        const [rows] = await client.query(sql, values)
        return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
      } finally { await client.end() }
    },
    cleanup: async () => {
      const client = await mysql.createConnection({ host, port, database, user: username, password })
      try { await client.query('DROP TABLE IF EXISTS dbweb_mutation_test') }
      finally { await client.end() }
    },
    selectSql: 'SELECT id, name, amount FROM dbweb_mutation_test ORDER BY id',
    externalUpdateSql: 'UPDATE dbweb_mutation_test SET name = ? WHERE id = ?',
  })
})

interface DialectFixture {
  setup(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>
  cleanup(): Promise<void>
  selectSql: string
  externalUpdateSql: string
}

function verifyDialect(gateway: DataMutationGateway, schema: string, fixture: DialectFixture): void {
  it('discovers stable keys and commits row mutations with optimistic locking', async () => {
    await fixture.setup()
    try {
      const metadata = await gateway.describeTable(connection, schema, 'dbweb_mutation_test')
      expect(metadata.uniqueKeys).toContainEqual(expect.objectContaining({ kind: 'primary', columns: ['id'] }))
      expect(metadata.columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'id', generated: true, valueType: 'number' }),
        expect.objectContaining({ name: 'amount', valueType: 'decimal' }),
      ]))

      const inserted = await gateway.executeTransaction(connection, {
        schema,
        table: 'dbweb_mutation_test',
        metadata,
        operations: [{ kind: 'insert', values: {
          name: { kind: 'value', type: 'string', value: 'alpha' },
          amount: { kind: 'value', type: 'decimal', value: '10.50' },
        } }],
      })
      expect(inserted).toMatchObject({ affectedRows: 1, items: [{ index: 0, affectedRows: 1 }] })

      const [row] = await fixture.query(fixture.selectSql)
      expect(row).toBeDefined()
      const id = Number(row?.id)
      const original = {
        id: { kind: 'value', type: 'number', value: id },
        name: { kind: 'value', type: 'string', value: 'alpha' },
        amount: { kind: 'value', type: 'decimal', value: '10.50' },
      } as const
      await gateway.executeTransaction(connection, {
        schema,
        table: 'dbweb_mutation_test',
        metadata,
        operations: [{ kind: 'update', identity: { id: original.id }, original, patch: {
          amount: { kind: 'value', type: 'decimal', value: '11.25' },
        } }],
      })
      expect((await fixture.query(fixture.selectSql))[0]).toMatchObject({ name: 'alpha', amount: '11.25' })

      await fixture.query(fixture.externalUpdateSql, ['outside', id])
      await expect(gateway.executeTransaction(connection, {
        schema,
        table: 'dbweb_mutation_test',
        metadata,
        operations: [
          { kind: 'insert', values: { name: { kind: 'value', type: 'string', value: 'rolled-back' }, amount: { kind: 'value', type: 'decimal', value: '1.00' } } },
          { kind: 'update', identity: { id: original.id }, original, patch: { name: { kind: 'value', type: 'string', value: 'stale' } } },
        ],
      })).rejects.toEqual(new DataMutationError('ROW_CONFLICT', 1))
      expect(await fixture.query(fixture.selectSql)).toEqual([expect.objectContaining({ name: 'outside' })])

      const current = {
        id: original.id,
        name: { kind: 'value', type: 'string', value: 'outside' },
        amount: { kind: 'value', type: 'decimal', value: '11.25' },
      } as const
      await gateway.executeTransaction(connection, {
        schema,
        table: 'dbweb_mutation_test',
        metadata,
        operations: [{ kind: 'delete', identity: { id: original.id }, original: current, confirmed: true }],
      })
      expect(await fixture.query(fixture.selectSql)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)
}
