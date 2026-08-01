import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpus, platform, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'

import {
  summarizePerformanceSamples,
  type PerformanceRequestSample,
  type PerformanceRun,
} from './performance-contract.js'

const execFileAsync = promisify(execFile)

interface AuthSession {
  cookie: string
  csrfToken: string
}

interface PerformanceRunnerOptions {
  baseUrl: string
  revision: string
  output: string
  composeProject: string
  connectionProfiles: number
  concurrentOperators: number
  warmupSeconds: number
  steadySeconds: number
  smoke: boolean
  databaseHost: string
  databasePort: number
  databaseName: string
  databaseUsername: string
  databasePassword: string
  adminUsername: string
  adminPassword: string
}

export interface PerformanceProfileOptions {
  connectionProfiles: number
  concurrentOperators: number
  warmupSeconds: number
  steadySeconds: number
  smoke: boolean
}

interface PerformanceSetupFetchOptions {
  attempts?: number
  retryDelayMs?: number
  fetcher?: typeof fetch
}

export function validatePerformanceRunnerOptions(
  input: PerformanceProfileOptions,
): PerformanceProfileOptions {
  const profile: PerformanceProfileOptions = {
    connectionProfiles: input.connectionProfiles,
    concurrentOperators: input.concurrentOperators,
    warmupSeconds: input.warmupSeconds,
    steadySeconds: input.steadySeconds,
    smoke: input.smoke,
  }
  for (const [name, value] of Object.entries(profile)) {
    if (name === 'smoke') continue
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new TypeError(`${name} must be a positive integer`)
    }
  }
  if (!profile.smoke && (
    profile.connectionProfiles !== 100
    || profile.concurrentOperators !== 10
    || profile.warmupSeconds !== 120
    || profile.steadySeconds !== 600
  )) {
    throw new TypeError('full performance profile must use 100 connections, 10 operators, 120s warmup, and 600s steady state')
  }
  return profile
}

export function parseContainerMemoryUsage(value: string): number {
  const used = value.split('/', 1)[0]?.trim() ?? ''
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)$/.exec(used)
  if (!match) {
    throw new TypeError(`invalid Docker memory usage: ${value}`)
  }
  const amount = Number(match[1])
  const unit = match[2] as string
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    MB: 1_000 ** 2,
    GB: 1_000 ** 3,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
  }
  return amount * (multipliers[unit] as number)
}

export async function fetchPerformanceSetup(
  input: string | URL | Request,
  init?: RequestInit,
  options: PerformanceSetupFetchOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 30
  const retryDelayMs = options.retryDelayMs ?? 1_000
  const fetcher = options.fetcher ?? fetch
  if (!Number.isSafeInteger(attempts) || attempts < 1 || retryDelayMs < 0) {
    throw new TypeError('invalid performance setup retry options')
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetcher(input, init)
    if (![502, 503, 504].includes(response.status) || attempt === attempts) {
      return response
    }
    await delay(retryDelayMs)
  }
  throw new Error('performance setup retry loop exhausted')
}

async function main(): Promise<void> {
  const options = parseOptions()
  validatePerformanceRunnerOptions(options)
  const admin = await login(options)
  const connectionIds = await provisionDatabase(options, admin)

  await runPhase(options, admin, connectionIds, options.warmupSeconds * 1_000)

  const rssSamplesBytes: number[] = []
  const rssController = new AbortController()
  const rssTask = sampleRss(options.composeProject, rssSamplesBytes, rssController.signal)
  const startedAt = performance.now()
  const requests = await runPhase(
    options,
    admin,
    connectionIds,
    options.steadySeconds * 1_000,
    true,
  )
  const durationMs = performance.now() - startedAt
  rssController.abort()
  await rssTask
  if (rssSamplesBytes.length === 0) {
    rssSamplesBytes.push(await readApiRss(options.composeProject))
  }

  const cpu = cpus()
  const result: PerformanceRun = {
    revision: options.revision,
    runner: {
      cpuModel: cpu[0]?.model ?? 'unknown',
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
      platform: platform(),
      nodeVersion: process.version,
    },
    profile: {
      connectionProfiles: options.connectionProfiles,
      concurrentOperators: options.concurrentOperators,
      warmupSeconds: options.warmupSeconds,
      steadySeconds: options.steadySeconds,
    },
    metrics: summarizePerformanceSamples({ durationMs, requests, rssSamplesBytes }),
  }
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function parseOptions(): PerformanceRunnerOptions {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://127.0.0.1:3000' },
      revision: { type: 'string' },
      output: { type: 'string' },
      'compose-project': { type: 'string', default: 'dbweb-perf' },
      connections: { type: 'string', default: '100' },
      operators: { type: 'string', default: '10' },
      warmup: { type: 'string', default: '120' },
      steady: { type: 'string', default: '600' },
      smoke: { type: 'boolean', default: false },
    },
  })
  if (!values.revision || !values.output) {
    throw new TypeError('--revision and --output are required')
  }
  return {
    baseUrl: values['base-url'] as string,
    revision: values.revision,
    output: values.output,
    composeProject: values['compose-project'] as string,
    connectionProfiles: parseInteger(values.connections as string, 'connections'),
    concurrentOperators: parseInteger(values.operators as string, 'operators'),
    warmupSeconds: parseInteger(values.warmup as string, 'warmup'),
    steadySeconds: parseInteger(values.steady as string, 'steady'),
    smoke: values.smoke as boolean,
    databaseHost: process.env['DBWEB_PERFORMANCE_DATABASE_HOST'] ?? 'postgres',
    databasePort: parseInteger(process.env['DBWEB_PERFORMANCE_DATABASE_PORT'] ?? '5432', 'database port'),
    databaseName: process.env['DBWEB_PERFORMANCE_DATABASE'] ?? 'dbweb',
    databaseUsername: process.env['DBWEB_PERFORMANCE_DATABASE_USERNAME'] ?? 'dbweb',
    databasePassword: requiredEnvironment('DBWEB_PERFORMANCE_DATABASE_PASSWORD'),
    adminUsername: process.env['DBWEB_PERFORMANCE_ADMIN_USERNAME'] ?? 'admin',
    adminPassword: requiredEnvironment('DBWEB_PERFORMANCE_ADMIN_PASSWORD'),
  }
}

async function login(options: PerformanceRunnerOptions): Promise<AuthSession> {
  const response = await fetchPerformanceSetup(`${options.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: options.adminUsername, password: options.adminPassword }),
  })
  const payload = await jsonResponse<{ csrfToken: string }>(response)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('login response did not include a session cookie')
  return { cookie, csrfToken: payload.csrfToken }
}

async function provisionDatabase(
  options: PerformanceRunnerOptions,
  session: AuthSession,
): Promise<string[]> {
  const connectionIds: string[] = []
  for (let index = 0; index < options.connectionProfiles; index += 1) {
    const profile = await apiRequest<{ id: string }>(options, session, '/api/connections', {
      method: 'POST',
      body: {
        name: `Performance ${String(index + 1).padStart(3, '0')}`,
        engine: 'postgres',
        host: options.databaseHost,
        port: options.databasePort,
        database: options.databaseName,
        username: options.databaseUsername,
        password: options.databasePassword,
        tls: { mode: 'disable' },
        keepAlive: { enabled: false },
        ssh: { enabled: false },
      },
    })
    connectionIds.push(profile.id)
  }
  await apiRequest(options, session, '/api/queries', {
    method: 'POST',
    body: {
      queryId: randomUUID(),
      connectionId: connectionIds[0],
      sql: [
        'CREATE TABLE IF NOT EXISTS public.dbweb_performance_rows (id bigint PRIMARY KEY, payload text NOT NULL)',
        'TRUNCATE TABLE public.dbweb_performance_rows',
        "INSERT INTO public.dbweb_performance_rows (id, payload) SELECT value, repeat('x', 128) FROM generate_series(1, 1000000) AS value",
      ].join('; '),
      timeoutMs: 300_000,
      rowLimit: 1,
      confirmedHighRisk: true,
    },
  })
  return connectionIds
}

async function runPhase(
  options: PerformanceRunnerOptions,
  session: AuthSession,
  connectionIds: string[],
  durationMs: number,
  collect = false,
): Promise<PerformanceRequestSample[]> {
  const samples: PerformanceRequestSample[] = []
  const deadline = performance.now() + durationMs
  await Promise.all(Array.from({ length: options.concurrentOperators }, async (_, operatorIndex) => {
    let requestIndex = operatorIndex
    while (performance.now() < deadline) {
      const connectionId = connectionIds[requestIndex % connectionIds.length] as string
      const sample = requestIndex % 2 === 0
        ? await requestRows(options, session, connectionId)
        : await requestSqlStream(options, session, connectionId, requestIndex)
      if (collect) samples.push(sample)
      requestIndex += options.concurrentOperators
    }
  }))
  return samples
}

async function requestRows(
  options: PerformanceRunnerOptions,
  session: AuthSession,
  connectionId: string,
): Promise<PerformanceRequestSample> {
  const startedAt = performance.now()
  try {
    const response = await fetch(
      `${options.baseUrl}/api/connections/${connectionId}/schemas/public/tables/dbweb_performance_rows/rows?limit=1000&offset=0`,
      { headers: { cookie: session.cookie } },
    )
    const ttfbMs = performance.now() - startedAt
    await response.arrayBuffer()
    return { durationMs: performance.now() - startedAt, ttfbMs, ok: response.ok }
  } catch {
    const durationMs = performance.now() - startedAt
    return { durationMs, ttfbMs: durationMs, ok: false }
  }
}

async function requestSqlStream(
  options: PerformanceRunnerOptions,
  session: AuthSession,
  connectionId: string,
  requestIndex: number,
): Promise<PerformanceRequestSample> {
  const startedAt = performance.now()
  try {
    const lowerBound = (requestIndex * 1_000) % 999_000
    const response = await fetch(`${options.baseUrl}/api/queries/stream`, {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        queryId: randomUUID(),
        connectionId,
        sql: `SELECT id, payload FROM public.dbweb_performance_rows WHERE id > ${lowerBound} ORDER BY id LIMIT 1000`,
        timeoutMs: 30_000,
        rowLimit: 100_000,
        byteLimit: 268_435_456,
      }),
    })
    const ttfbMs = performance.now() - startedAt
    await response.arrayBuffer()
    return { durationMs: performance.now() - startedAt, ttfbMs, ok: response.ok }
  } catch {
    const durationMs = performance.now() - startedAt
    return { durationMs, ttfbMs: durationMs, ok: false }
  }
}

async function apiRequest<T = unknown>(
  options: PerformanceRunnerOptions,
  session: AuthSession,
  path: string,
  input: { method: string; body?: unknown },
): Promise<T> {
  const response = await fetchPerformanceSetup(`${options.baseUrl}${path}`, {
    method: input.method,
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  return await jsonResponse<T>(response)
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return JSON.parse(text) as T
}

async function sampleRss(project: string, samples: number[], signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    samples.push(await readApiRss(project))
    await abortableDelay(5_000, signal)
  }
}

async function readApiRss(project: string): Promise<number> {
  const { stdout } = await execFileAsync('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}}|{{.MemUsage}}',
  ])
  const prefix = `${project}-api-`
  const values = stdout.trim().split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const separator = line.indexOf('|')
    if (separator < 0 || !line.slice(0, separator).startsWith(prefix)) return []
    return [parseContainerMemoryUsage(line.slice(separator + 1))]
  })
  if (values.length !== 3) {
    throw new Error(`expected three API containers for ${project}, found ${values.length}`)
  }
  return values.reduce((sum, value) => sum + value, 0)
}

async function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs)
    timer.unref()
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return parsed
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

async function delay(durationMs: number): Promise<void> {
  if (durationMs === 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs))
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
