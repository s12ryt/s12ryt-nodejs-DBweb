import { describe, expect, it } from 'vitest';

import {
  fetchPerformanceSetup,
  parseContainerMemoryUsage,
  validatePerformanceRunnerOptions,
} from './performance-runner.js';

describe('performance runner', () => {
  it('parses Docker memory units without decimal-unit ambiguity', () => {
    expect(parseContainerMemoryUsage('512KiB / 1GiB')).toBe(512 * 1024);
    expect(parseContainerMemoryUsage('1.5MiB / 2GiB')).toBe(1.5 * 1024 ** 2);
    expect(parseContainerMemoryUsage('1.25GiB / 4GiB')).toBe(1.25 * 1024 ** 3);
    expect(parseContainerMemoryUsage('2MB / 4GB')).toBe(2_000_000);
    expect(() => parseContainerMemoryUsage('unknown')).toThrow('invalid Docker memory usage');
  });

  it('requires the contractual full profile unless smoke mode is explicit', () => {
    expect(validatePerformanceRunnerOptions({
      connectionProfiles: 100,
      concurrentOperators: 10,
      warmupSeconds: 120,
      steadySeconds: 600,
      smoke: false,
    })).toEqual({
      connectionProfiles: 100,
      concurrentOperators: 10,
      warmupSeconds: 120,
      steadySeconds: 600,
      smoke: false,
    });

    expect(() => validatePerformanceRunnerOptions({
      connectionProfiles: 10,
      concurrentOperators: 2,
      warmupSeconds: 5,
      steadySeconds: 10,
      smoke: false,
    })).toThrow('full performance profile');

    expect(validatePerformanceRunnerOptions({
      connectionProfiles: 10,
      concurrentOperators: 2,
      warmupSeconds: 5,
      steadySeconds: 10,
      smoke: true,
    }).smoke).toBe(true);
  });

  it('validates only profile fields when called with complete runtime options', () => {
    const runtimeOptions = {
      baseUrl: 'http://127.0.0.1:3000',
      revision: 'candidate',
      connectionProfiles: 100,
      concurrentOperators: 10,
      warmupSeconds: 120,
      steadySeconds: 600,
      smoke: false,
    };

    expect(validatePerformanceRunnerOptions(runtimeOptions)).toEqual({
      connectionProfiles: 100,
      concurrentOperators: 10,
      warmupSeconds: 120,
      steadySeconds: 600,
      smoke: false,
    });
  });

  it('retries only transient gateway failures during setup', async () => {
    const statuses = [503, 502, 200];
    const fetcher = async (): Promise<Response> => new Response('{}', {
      status: statuses.shift() ?? 500,
      headers: { 'content-type': 'application/json' },
    });

    const response = await fetchPerformanceSetup('http://dbweb.test/api/auth/login', {}, {
      attempts: 3,
      retryDelayMs: 0,
      fetcher,
    });

    expect(response.status).toBe(200);
    expect(statuses).toEqual([]);
  });

  it('does not retry non-transient setup responses', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return new Response('{}', { status: 401 });
    };

    const response = await fetchPerformanceSetup('http://dbweb.test/api/auth/login', {}, {
      attempts: 3,
      retryDelayMs: 0,
      fetcher,
    });

    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });
});
