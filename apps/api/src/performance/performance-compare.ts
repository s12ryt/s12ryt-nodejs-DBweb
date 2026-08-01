import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  evaluatePerformanceCandidate,
  type PerformanceRun,
} from './performance-contract.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
    },
  })
  if (!values.baseline || !values.candidate) {
    throw new TypeError('--baseline and --candidate are required')
  }
  const baseline = await readRun(values.baseline)
  const candidate = await readRun(values.candidate)
  assertComparable(baseline, candidate)
  const evaluation = evaluatePerformanceCandidate(baseline, candidate)
  process.stdout.write(`${JSON.stringify({ baseline, candidate, evaluation }, null, 2)}\n`)
  if (!evaluation.passed) {
    process.exitCode = 1
  }
}

async function readRun(path: string): Promise<PerformanceRun> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isPerformanceRun(value)) {
    throw new TypeError(`${path} is not a valid performance run`)
  }
  return value
}

function assertComparable(baseline: PerformanceRun, candidate: PerformanceRun): void {
  if (JSON.stringify(baseline.profile) !== JSON.stringify(candidate.profile)) {
    throw new TypeError('baseline and candidate profiles differ')
  }
  const baselineRunner = { ...baseline.runner, nodeVersion: undefined }
  const candidateRunner = { ...candidate.runner, nodeVersion: undefined }
  if (JSON.stringify(baselineRunner) !== JSON.stringify(candidateRunner)) {
    throw new TypeError('baseline and candidate runner specifications differ')
  }
}

function isPerformanceRun(value: unknown): value is PerformanceRun {
  if (!isRecord(value) || typeof value['revision'] !== 'string') return false
  const runner = value['runner']
  const profile = value['profile']
  const metrics = value['metrics']
  return isRecord(runner)
    && typeof runner['cpuModel'] === 'string'
    && Number.isInteger(runner['logicalCpus'])
    && typeof runner['totalMemoryBytes'] === 'number'
    && typeof runner['platform'] === 'string'
    && typeof runner['nodeVersion'] === 'string'
    && isRecord(profile)
    && Object.values(profile).every((item) => typeof item === 'number')
    && isRecord(metrics)
    && Object.values(metrics).every((item) => typeof item === 'number')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
