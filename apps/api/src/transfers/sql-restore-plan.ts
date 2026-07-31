import type { DatabaseEngine } from '../connections/connection-types.js'
import type { DdlCommand } from '../ddl/ddl-command.js'
import {
  validateSqlDumpManifest,
  type SqlDumpObject,
  type SqlDumpObjectKind,
} from './sql-dump-manifest.js'

export type SqlRestorePlanErrorCode =
  | 'RESTORE_CAPABILITY_UNSUPPORTED'
  | 'RESTORE_CONFIRMATION_REQUIRED'
  | 'RESTORE_DEPENDENCY_CYCLE'
  | 'RESTORE_OBJECT_EXISTS'

export class SqlRestorePlanError extends Error {
  constructor(readonly code: SqlRestorePlanErrorCode) {
    super(code)
    this.name = 'SqlRestorePlanError'
  }
}

export interface SqlRestorePlanInput {
  engine: DatabaseEngine
  targetDatabase: string
  existingObjectIds: string[]
  mode: 'stop' | 'drop-and-recreate'
  confirmationDatabase?: string
  supportedKinds: readonly SqlDumpObjectKind[]
  skipUnsupported?: boolean
}

export interface SqlRestoreStep {
  phase: 'structure' | 'data' | 'dependent'
  objectId: string
  commands: DdlCommand[]
  dataEntry?: string
}

export interface SqlRestorePlan {
  engine: DatabaseEngine
  targetDatabase: string
  dropObjectIds: string[]
  dropCommands: DdlCommand[]
  skippedObjectIds: string[]
  steps: SqlRestoreStep[]
}

export function buildSqlRestorePlan(manifestValue: unknown, input: SqlRestorePlanInput): SqlRestorePlan {
  const manifest = validateSqlDumpManifest(manifestValue, input.engine)
  if (!input.targetDatabase.trim() || input.targetDatabase.includes('\0')) {
    throw new SqlRestorePlanError('RESTORE_CONFIRMATION_REQUIRED')
  }
  const objectMap = new Map(manifest.objects.map((object) => [object.id, object]))
  const existing = uniqueKnownIds(input.existingObjectIds, objectMap)
  if (existing.length > 0 && input.mode === 'stop') throw new SqlRestorePlanError('RESTORE_OBJECT_EXISTS')
  if (
    existing.length > 0
    && (input.mode !== 'drop-and-recreate' || input.confirmationDatabase !== input.targetDatabase)
  ) throw new SqlRestorePlanError('RESTORE_CONFIRMATION_REQUIRED')

  const supported = new Set(input.supportedKinds)
  const skipped = determineSkipped(manifest.objects, supported, input.skipUnsupported === true)
  const included = manifest.objects.filter((object) => !skipped.has(object.id))
  const ordered = topologicalOrder(included)
  const includedIds = new Set(included.map((object) => object.id))
  const dropOrdered = [...ordered]
    .reverse()
    .filter((object) => existing.includes(object.id) && includedIds.has(object.id))

  const steps: SqlRestoreStep[] = []
  for (const object of ordered) {
    steps.push({ phase: phaseFor(object.kind), objectId: object.id, commands: object.createCommands })
    if (object.dataEntry !== undefined) {
      steps.push({ phase: 'data', objectId: object.id, commands: [], dataEntry: object.dataEntry })
    }
  }
  steps.sort((left, right) => phaseRank(left.phase) - phaseRank(right.phase))

  return {
    engine: manifest.engine,
    targetDatabase: input.targetDatabase,
    dropObjectIds: dropOrdered.map((object) => object.id),
    dropCommands: dropOrdered.map((object) => object.dropCommand),
    skippedObjectIds: manifest.objects.filter((object) => skipped.has(object.id)).map((object) => object.id),
    steps,
  }
}

function determineSkipped(
  objects: SqlDumpObject[],
  supported: ReadonlySet<SqlDumpObjectKind>,
  allowSkip: boolean,
): Set<string> {
  const skipped = new Set(objects.filter((object) => !supported.has(object.kind)).map((object) => object.id))
  if (skipped.size > 0 && !allowSkip) throw new SqlRestorePlanError('RESTORE_CAPABILITY_UNSUPPORTED')
  let changed = true
  while (changed) {
    changed = false
    for (const object of objects) {
      if (!skipped.has(object.id) && object.dependencies.some((dependency) => skipped.has(dependency))) {
        skipped.add(object.id)
        changed = true
      }
    }
  }
  return skipped
}

function topologicalOrder(objects: SqlDumpObject[]): SqlDumpObject[] {
  const ids = new Set(objects.map((object) => object.id))
  const pending = new Map(objects.map((object) => [
    object.id,
    new Set(object.dependencies.filter((dependency) => ids.has(dependency))),
  ]))
  const byId = new Map(objects.map((object) => [object.id, object]))
  const result: SqlDumpObject[] = []

  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort()
    if (ready.length === 0) throw new SqlRestorePlanError('RESTORE_DEPENDENCY_CYCLE')
    for (const id of ready) {
      result.push(byId.get(id)!)
      pending.delete(id)
      for (const dependencies of pending.values()) dependencies.delete(id)
    }
  }
  return result
}

function uniqueKnownIds(ids: string[], objects: ReadonlyMap<string, SqlDumpObject>): string[] {
  return [...new Set(ids)].filter((id) => objects.has(id))
}

function phaseFor(kind: SqlDumpObjectKind): SqlRestoreStep['phase'] {
  return ['schema', 'type', 'domain', 'sequence', 'table'].includes(kind) ? 'structure' : 'dependent'
}

function phaseRank(phase: SqlRestoreStep['phase']): number {
  if (phase === 'structure') return 0
  if (phase === 'data') return 1
  return 2
}
