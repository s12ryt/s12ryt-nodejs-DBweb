import { describe, expect, it } from 'vitest';

import {
  evaluatePerformanceCandidate,
  summarizePerformanceSamples,
  type PerformanceRun,
} from './performance-contract.js';

describe('performance contract', () => {
  it('summarizes latency, TTFB, throughput, errors, and RSS deterministically', () => {
    expect(
      summarizePerformanceSamples({
        durationMs: 10_000,
        requests: [
          { durationMs: 80, ttfbMs: 20, ok: true },
          { durationMs: 100, ttfbMs: 30, ok: true },
          { durationMs: 120, ttfbMs: 40, ok: true },
          { durationMs: 140, ttfbMs: 50, ok: false },
        ],
        rssSamplesBytes: [900_000_000, 990_000_000],
      }),
    ).toEqual({
      requestCount: 4,
      successfulRequests: 3,
      errorRate: 0.25,
      throughputPerSecond: 0.3,
      latencyP95Ms: 140,
      ttfbP95Ms: 50,
      peakRssBytes: 990_000_000,
      rssGrowthRatio: 0.1,
    });
  });

  it('accepts a candidate that remains within every relative and absolute gate', () => {
    const baseline = run({
      latencyP95Ms: 100,
      ttfbP95Ms: 40,
      throughputPerSecond: 100,
      errorRate: 0,
      peakRssBytes: 1_000_000_000,
      rssGrowthRatio: 0.02,
    });
    const candidate = run({
      latencyP95Ms: 114,
      ttfbP95Ms: 45,
      throughputPerSecond: 86,
      errorRate: 0.009,
      peakRssBytes: 1_400_000_000,
      rssGrowthRatio: 0.099,
    });

    expect(evaluatePerformanceCandidate(baseline, candidate)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it('reports each violated gate without hiding the remaining failures', () => {
    const baseline = run({
      latencyP95Ms: 100,
      ttfbP95Ms: 40,
      throughputPerSecond: 100,
      errorRate: 0,
      peakRssBytes: 900_000_000,
      rssGrowthRatio: 0.01,
    });
    const candidate = run({
      latencyP95Ms: 116,
      ttfbP95Ms: 47,
      throughputPerSecond: 84,
      errorRate: 0.011,
      peakRssBytes: 1_610_612_737,
      rssGrowthRatio: 0.101,
    });

    expect(evaluatePerformanceCandidate(baseline, candidate)).toEqual({
      passed: false,
      failures: [
        'LATENCY_P95_REGRESSION',
        'TTFB_P95_REGRESSION',
        'THROUGHPUT_REGRESSION',
        'ERROR_RATE_EXCEEDED',
        'RSS_LIMIT_EXCEEDED',
        'RSS_GROWTH_EXCEEDED',
      ],
    });
  });
});

function run(
  metrics: Omit<PerformanceRun['metrics'], 'requestCount' | 'successfulRequests'>,
): PerformanceRun {
  return {
    revision: 'test-revision',
    runner: {
      cpuModel: 'test-cpu',
      logicalCpus: 4,
      totalMemoryBytes: 8_000_000_000,
      platform: 'linux',
      nodeVersion: 'v24.0.0',
    },
    profile: {
      connectionProfiles: 100,
      concurrentOperators: 10,
      warmupSeconds: 120,
      steadySeconds: 600,
    },
    metrics: {
      requestCount: 1_000,
      successfulRequests: 1_000,
      ...metrics,
    },
  };
}
