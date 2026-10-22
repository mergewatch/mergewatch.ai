import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_PRICING, estimateCost } from './pricing.js';
import { CONTEXT_WINDOWS } from './context-windows.js';

/**
 * #722 — every live Bedrock Anthropic profile is priced and windowed.
 *
 * An unpriced model id does not fail loudly: `estimateCost` returns null, the
 * review's cost is null, and on SaaS `recordReview` is skipped — no free-tier
 * count, no debit, no charge. 19 of 29 live us-west-2 profiles were in that
 * state when this landed.
 *
 * The snapshot is generated from AWS by `scripts/check-bedrock-profiles.mjs
 * --write`, and the release gate re-checks it against AWS. This test checks the
 * two tables against the snapshot, in both directions.
 */
const SNAPSHOT: string[] = JSON.parse(
  readFileSync(new URL('./bedrock-profiles.us-west-2.json', import.meta.url), 'utf8'),
);
const PROFILE_KEY = /^(us|global)\./;
const M = 1_000_000;

describe('Bedrock profile coverage (#722)', () => {
  it('every live profile in the snapshot is in DEFAULT_PRICING and CONTEXT_WINDOWS', () => {
    const unpriced = SNAPSHOT.filter((id) => !(id in DEFAULT_PRICING));
    const unwindowed = SNAPSHOT.filter((id) => !(id in CONTEXT_WINDOWS));
    expect(unpriced, 'live profiles missing from DEFAULT_PRICING').toEqual([]);
    expect(unwindowed, 'live profiles missing from CONTEXT_WINDOWS').toEqual([]);
  });

  it('every us./global. key in either table is a live profile in the snapshot', () => {
    const stale = [...Object.keys(DEFAULT_PRICING), ...Object.keys(CONTEXT_WINDOWS)]
      .filter((id) => PROFILE_KEY.test(id) && !SNAPSHOT.includes(id));
    expect([...new Set(stale)], 'table keys that are not live profiles').toEqual([]);
  });

  // Without a floor, deleting the same ids from the snapshot and both tables
  // would keep the two tests above green.
  it('the snapshot has not been trimmed below the models MergeWatch runs', () => {
    for (const prefix of ['us', 'global']) {
      for (const model of ['sonnet-5-5', 'opus-5-5', 'fable-5-1', 'haiku-5-5', 'opus-4-8']) {
        expect(SNAPSHOT, 'snapshot floor').toContain(`${prefix}.anthropic.claude-${model}`);
      }
    }
  });

  it('the two tables have the same keys, and every key prices to a number', () => {
    expect(Object.keys(CONTEXT_WINDOWS).sort()).toEqual(Object.keys(DEFAULT_PRICING).sort());
    for (const id of Object.keys(DEFAULT_PRICING)) {
      expect(estimateCost(id, M, M), `${id} priced`).not.toBeNull();
    }
  });
});
