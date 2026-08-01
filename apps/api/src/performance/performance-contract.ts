export interface PerformanceRequestSample {
  durationMs: number;
  ttfbMs: number;
  ok: boolean;
}

export interface PerformanceMetrics {
  requestCount: number;
  successfulRequests: number;
  errorRate: number;
  throughputPerSecond: number;
  latencyP95Ms: number;
  ttfbP95Ms: number;
  peakRssBytes: number;
  rssGrowthRatio: number;
}

export interface PerformanceRunnerDetails {
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  platform: string;
  nodeVersion: string;
}

export interface PerformanceProfile {
  connectionProfiles: number;
  concurrentOperators: number;
  warmupSeconds: number;
  steadySeconds: number;
}

export interface PerformanceRun {
  revision: string;
  runner: PerformanceRunnerDetails;
  profile: PerformanceProfile;
  metrics: PerformanceMetrics;
}

export type PerformanceFailure =
  | 'LATENCY_P95_REGRESSION'
  | 'TTFB_P95_REGRESSION'
  | 'THROUGHPUT_REGRESSION'
  | 'ERROR_RATE_EXCEEDED'
  | 'RSS_LIMIT_EXCEEDED'
  | 'RSS_GROWTH_EXCEEDED';

export interface PerformanceEvaluation {
  passed: boolean;
  failures: PerformanceFailure[];
}

export function summarizePerformanceSamples(input: {
  durationMs: number;
  requests: PerformanceRequestSample[];
  rssSamplesBytes: number[];
}): PerformanceMetrics {
  assertPositiveFinite(input.durationMs, 'durationMs');
  if (input.requests.length === 0) {
    throw new TypeError('requests must not be empty');
  }
  if (input.rssSamplesBytes.length === 0) {
    throw new TypeError('rssSamplesBytes must not be empty');
  }

  const successfulRequests = input.requests.filter((sample) => sample.ok).length;
  const firstRss = input.rssSamplesBytes[0] as number;
  const lastRss = input.rssSamplesBytes.at(-1) as number;
  for (const sample of input.requests) {
    assertNonNegativeFinite(sample.durationMs, 'request duration');
    assertNonNegativeFinite(sample.ttfbMs, 'request TTFB');
  }
  for (const rss of input.rssSamplesBytes) {
    assertNonNegativeFinite(rss, 'RSS sample');
  }

  return {
    requestCount: input.requests.length,
    successfulRequests,
    errorRate: (input.requests.length - successfulRequests) / input.requests.length,
    throughputPerSecond: successfulRequests / (input.durationMs / 1_000),
    latencyP95Ms: percentile95(input.requests.map((sample) => sample.durationMs)),
    ttfbP95Ms: percentile95(input.requests.map((sample) => sample.ttfbMs)),
    peakRssBytes: Math.max(...input.rssSamplesBytes),
    rssGrowthRatio: firstRss === 0 ? (lastRss === 0 ? 0 : Number.POSITIVE_INFINITY) : (lastRss - firstRss) / firstRss,
  };
}

export function evaluatePerformanceCandidate(
  baseline: PerformanceRun,
  candidate: PerformanceRun,
): PerformanceEvaluation {
  const failures: PerformanceFailure[] = [];
  if (regressionRatio(baseline.metrics.latencyP95Ms, candidate.metrics.latencyP95Ms) > 0.15) {
    failures.push('LATENCY_P95_REGRESSION');
  }
  if (regressionRatio(baseline.metrics.ttfbP95Ms, candidate.metrics.ttfbP95Ms) > 0.15) {
    failures.push('TTFB_P95_REGRESSION');
  }
  if (throughputLossRatio(baseline.metrics.throughputPerSecond, candidate.metrics.throughputPerSecond) > 0.15) {
    failures.push('THROUGHPUT_REGRESSION');
  }
  if (candidate.metrics.errorRate >= 0.01) {
    failures.push('ERROR_RATE_EXCEEDED');
  }
  if (candidate.metrics.peakRssBytes > 1.5 * 1024 ** 3) {
    failures.push('RSS_LIMIT_EXCEEDED');
  }
  if (candidate.metrics.rssGrowthRatio > 0.1) {
    failures.push('RSS_GROWTH_EXCEEDED');
  }
  return { passed: failures.length === 0, failures };
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number;
}

function regressionRatio(baseline: number, candidate: number): number {
  if (baseline === 0) {
    return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (candidate - baseline) / baseline;
}

function throughputLossRatio(baseline: number, candidate: number): number {
  if (baseline === 0) {
    return 0;
  }
  return (baseline - candidate) / baseline;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}
