import { describe, expect, it } from 'vitest';

import {
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
});
