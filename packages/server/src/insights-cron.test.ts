import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runInsightRollup is the only @mergewatch/core symbol insights-cron calls at
// runtime; stub it so the scheduler tests don't touch real stores.
vi.mock('@mergewatch/core', () => ({
  runInsightRollup: vi.fn().mockResolvedValue({
    installationsProcessed: 0,
    rowsWritten: 0,
    installationsFailed: [],
    elapsedMs: 1,
  }),
}));

import { resolveRollupIntervalMs, startInsightsCron } from './insights-cron.js';
import { runInsightRollup } from '@mergewatch/core';

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

describe('resolveRollupIntervalMs', () => {
  it('defaults to hourly when unset', () => {
    expect(resolveRollupIntervalMs(undefined)).toBe(HOUR_MS);
  });

  it('honors a valid positive interval (minutes → ms)', () => {
    expect(resolveRollupIntervalMs('30')).toBe(30 * 60 * 1000);
    expect(resolveRollupIntervalMs('120')).toBe(120 * 60 * 1000);
    expect(resolveRollupIntervalMs('1')).toBe(60 * 1000);
  });

  it('falls back to hourly for non-numeric values', () => {
    expect(resolveRollupIntervalMs('abc')).toBe(HOUR_MS);
    expect(resolveRollupIntervalMs('')).toBe(HOUR_MS);
  });

  it('falls back to hourly for non-positive values', () => {
    expect(resolveRollupIntervalMs('0')).toBe(HOUR_MS);
    expect(resolveRollupIntervalMs('-15')).toBe(HOUR_MS);
  });

  it('reads from process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES by default', () => {
    const prev = process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES;
    process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES = '5';
    try {
      expect(resolveRollupIntervalMs()).toBe(5 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES;
      else process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES = prev;
    }
  });
});

describe('startInsightsCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES;
  });

  it('runs once after the startup delay, then on each configured interval, and stops cleanly', async () => {
    process.env.INSIGHTS_ROLLUP_INTERVAL_MINUTES = '30';
    const handle = startInsightsCron({} as never);

    // Nothing fires before the startup delay elapses.
    expect(runInsightRollup).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runInsightRollup).toHaveBeenCalledTimes(1);

    // Then once per configured interval (30 min).
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(runInsightRollup).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(runInsightRollup).toHaveBeenCalledTimes(3);

    // After stop(), no further runs.
    handle.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runInsightRollup).toHaveBeenCalledTimes(3);
  });

  it('defaults to an hourly interval when the env var is unset', async () => {
    const handle = startInsightsCron({} as never);

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runInsightRollup).toHaveBeenCalledTimes(1);

    // No fire before a full hour has passed...
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(runInsightRollup).toHaveBeenCalledTimes(1);
    // ...and exactly one more at the hour mark.
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(runInsightRollup).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
