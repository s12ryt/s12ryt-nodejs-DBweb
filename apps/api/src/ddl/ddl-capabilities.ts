import type { DatabaseEngine } from '../connections/connection-types.js'

export interface DatabaseVersion {
  major: number
  minor: number
  patch: number
  assumedMinimum: boolean
}

export interface DdlCapabilities {
  engine: DatabaseEngine
  version: DatabaseVersion
  transactionalDdl: boolean
  columnTypes: string[]
  database: {
    create: boolean
    drop: boolean
    rename: boolean
    owner: boolean
  }
  schema: {
    create: boolean
    drop: boolean
    rename: boolean
    owner: boolean
    databaseAlias: boolean
  }
  table: {
    create: boolean
    drop: boolean
    rename: boolean
    owner: boolean
    storageOptions: boolean
  }
  column: {
    generated: boolean
    identity: boolean
    rename: boolean
    renameSyntax: 'rename-column' | 'change-column'
  }
  constraint: {
    check: boolean
    foreignKey: boolean
    primaryKey: boolean
    unique: boolean
  }
  index: {
    methods: string[]
    expression: boolean
    partial: boolean
    prefixLength: boolean
  }
}

const POSTGRES_TYPES = [
  'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision',
  'boolean', 'text', 'varchar', 'char', 'bytea', 'date', 'time',
  'timestamp', 'timestamptz', 'uuid', 'json', 'jsonb',
]

const MYSQL_TYPES = [
  'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float',
  'double', 'bit', 'char', 'varchar', 'binary', 'varbinary', 'tinytext',
  'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob',
  'longblob', 'date', 'time', 'datetime', 'timestamp', 'enum',
]

export function detectDdlCapabilities(
  engine: DatabaseEngine,
  versionText: string,
): DdlCapabilities {
  const version = parseVersion(engine, versionText)
  if (engine === 'postgres') {
    return {
      engine,
      version,
      transactionalDdl: true,
      columnTypes: [...POSTGRES_TYPES],
      database: { create: true, drop: true, rename: true, owner: true },
      schema: { create: true, drop: true, rename: true, owner: true, databaseAlias: false },
      table: { create: true, drop: true, rename: true, owner: true, storageOptions: false },
      column: {
        generated: false,
        identity: atLeast(version, 10, 0),
        rename: true,
        renameSyntax: 'rename-column',
      },
      constraint: { check: true, foreignKey: true, primaryKey: true, unique: true },
      index: {
        methods: ['btree', 'hash', 'gin', 'gist', 'brin'],
        expression: true,
        partial: true,
        prefixLength: false,
      },
    }
  }

  const supportsJson = atLeast(version, 5, 7, 8)
  const supportsModernRename = atLeast(version, 8, 0)
  return {
    engine,
    version,
    transactionalDdl: false,
    columnTypes: [...MYSQL_TYPES, ...(supportsJson ? ['json'] : [])],
    database: { create: true, drop: true, rename: false, owner: false },
    schema: { create: true, drop: true, rename: false, owner: false, databaseAlias: true },
    table: { create: true, drop: true, rename: true, owner: false, storageOptions: true },
    column: {
      generated: atLeast(version, 5, 7),
      identity: true,
      rename: true,
      renameSyntax: supportsModernRename ? 'rename-column' : 'change-column',
    },
    constraint: {
      check: atLeast(version, 8, 0, 16),
      foreignKey: true,
      primaryKey: true,
      unique: true,
    },
    index: {
      methods: ['btree', 'hash', 'fulltext'],
      expression: false,
      partial: false,
      prefixLength: true,
    },
  }
}

function parseVersion(engine: DatabaseEngine, text: string): DatabaseVersion {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) {
    return engine === 'postgres'
      ? { major: 9, minor: 6, patch: 0, assumedMinimum: true }
      : { major: 5, minor: 6, patch: 0, assumedMinimum: true }
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    assumedMinimum: false,
  }
}

function atLeast(
  version: DatabaseVersion,
  major: number,
  minor: number,
  patch = 0,
): boolean {
  return version.major > major
    || (version.major === major && version.minor > minor)
    || (version.major === major && version.minor === minor && version.patch >= patch)
}
