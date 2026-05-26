import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE_PATH = resolve(__dirname, '../../../infra/template.yaml');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

const globalsBlock = (() => {
  const start = template.indexOf('\nGlobals:');
  const next = template.indexOf('\nResources:');
  if (start < 0 || next < 0 || next < start) {
    throw new Error('Could not locate Globals / Resources sections in template.yaml');
  }
  return template.slice(start, next);
})();

describe('infra/template.yaml — Globals.Function.Environment.Variables', () => {
  // Regression guard for #181 (FB-A writers silently writing to a non-existent
  // table because the env var only existed on InsightsRollupFunction). These
  // table names MUST live in Globals so every Lambda — current and future —
  // inherits them and resolves to the stage-suffixed table.
  it.each([
    'FINDING_DISPOSITIONS_TABLE',
    'FP_INSIGHTS_TABLE',
    'INSTALLATIONS_TABLE',
    'REVIEWS_TABLE',
  ])('exposes %s as a shared Lambda env var', (varName) => {
    expect(globalsBlock).toMatch(new RegExp(`^\\s+${varName}:`, 'm'));
  });
});
