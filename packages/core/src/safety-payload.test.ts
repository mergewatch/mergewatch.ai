import { describe, it, expect, vi } from 'vitest';
import {
  formatReviewComment,
  parseSafetyPayload,
  renderSafetyPayload,
  COMMENT_BODY_BUDGET,
} from './comment-formatter.js';
import { updateReviewComment } from './github/client.js';
import type { SafetyResult, SafetyAreaMatch } from './agents/safety.js';
import type { SafetyFactor, SafetyLevel } from './config/defaults.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const factor = (rating: number, label: SafetyLevel, note: string) => ({ rating, label, note });
function result(over: Partial<SafetyResult> = {}): SafetyResult {
  return {
    score: 50,
    uncappedScore: 50,
    band: 'caution',
    emoji: '⛅',
    factors: {
      blastRadius: factor(3, 'caution', 'Touches the send path.'),
      changeSize: factor(5, 'safe', '4 files, +120/−35.'),
      testing: factor(3, 'caution', 'Retry path is untested.'),
      errorMonitoring: factor(5, 'safe', 'Failures are logged.'),
      rollback: factor(3, 'caution', 'Plain revert, no flag.'),
    } as Record<SafetyFactor, ReturnType<typeof factor>>,
    concerns: [],
    matchedAreas: [],
    appliedAreas: [],
    appliedNotes: [],
    ...over,
  };
}
const area = (over: Partial<SafetyAreaMatch>): SafetyAreaMatch =>
  ({ matchedPatterns: ['db/migrations/**'], files: ['db/migrations/1.sql'], ...over });

const BASE = { summary: 'Adds a retry.', findings: [], mergeScore: 5, mergeScoreReason: 'Looks good.' };
const fmt = (safety?: SafetyResult, extra: Record<string, unknown> = {}, sha = SHA_A) =>
  formatReviewComment({ ...BASE, ...(safety ? { safety: { result: safety, headSha: sha } } : {}), ...extra });

const FACTOR_LINES = [
  '- Blast radius: caution. Touches the send path.',
  '- Change size: safe. 4 files, +120/−35.',
  '- Testing: caution. Retry path is untested.',
  '- Error monitoring: safe. Failures are logged.',
  '- Rollback: caution. Plain revert, no flag.',
];

describe('safety section (#713)', () => {
  it.each([
    [20, 'risky', '⛈️', '⛈️ **Safety: Risky (20/100)**'],
    [50, 'caution', '⛅', '⛅ **Safety: Caution (50/100)**'],
    [90, 'safe', '☀️', '☀️ **Safety: Safe (90/100)**'],
  ] as const)('score %i renders the band line and the five factors in order', (score, band, emoji, line) => {
    const body = fmt(result({ score, uncappedScore: score, band, emoji }));
    const lines = body.split('\n');
    const at = lines.indexOf(line);
    expect(at, body).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toMatch(/^<!-- mw-safety:/);
    const first = lines.indexOf(FACTOR_LINES[0]);
    expect(lines.slice(first, first + 5)).toEqual(FACTOR_LINES);
  });

  it('a clamped result names the clamp and the cap', () => {
    const r = result({
      score: 33, uncappedScore: 78, band: 'risky', emoji: '⛈️', clampedBy: 'Migrations',
      matchedAreas: [area({ name: 'Migrations', level: 'risky' })],
    });
    r.factors.blastRadius = { rating: 2, label: 'risky', note: 'Schema change.', cappedFrom: 5, cappedFromLabel: 'safe' };
    const body = fmt(r);
    expect(body).toContain('⛈️ **Safety: Risky (33/100)** — capped at 33 by Migrations (was 78)');
    expect(body).toContain('- Blast radius: risky. Schema change. (capped from safe by Migrations)');
  });

  it('a configured emoji renders, escaped', () => {
    expect(fmt(result({ band: 'risky', score: 20, uncappedScore: 20, emoji: '🔥' }))).toContain('🔥 **Safety: Risky');
    expect(fmt(result({ emoji: '<b>' }))).toContain('&lt;b&gt; **Safety: Caution');
  });

  it('lists matched areas with patterns, model-applied areas and notes; escapes config text', () => {
    const body = fmt(result({
      matchedAreas: [area({ name: 'x */ <!-- y -->', level: 'risky' }), area({ matchedPatterns: ['internal/**'] })],
      appliedAreas: ['Billing'],
      appliedNotes: ['Queued jobs run with the old arguments'],
      concerns: ['Retries could double-send.'],
    }));
    expect(body).toContain('Applied:');
    expect(body).toContain('- Area: x \\*/ &lt;\\!\\-\\- y \\-\\-&gt; (risky; db/migrations/\\*\\*)');
    expect(body).toContain('- Area: internal/\\*\\* (no level; internal/\\*\\*)');
    expect(body).toContain('- Area: Billing (judged by the model)');
    expect(body).toContain('- Note: Queued jobs run with the old arguments');
    expect(body).toContain('Concerns:\n- Retries could double-send.');
    expect(body).not.toContain('<!-- y -->');
  });

  it('omits Applied: and Concerns: when empty', () => {
    const body = fmt(result());
    // Non-vacuity: the section rendered, so the absences below mean something.
    expect(body).toContain(FACTOR_LINES[0]);
    expect(body).not.toContain('Applied:');
    expect(body).not.toContain('Concerns:');
  });
});

describe('the mw-safety line (#713)', () => {
  it('round-trips score, band, sha and areas — area names unescaped', () => {
    const r = result({
      score: 33, band: 'risky',
      matchedAreas: [area({ name: 'a } --> b', level: 'risky' })],
      appliedAreas: ['Billing'],
    });
    const body = fmt(r);
    expect(parseSafetyPayload(body)).toEqual({ score: 33, band: 'risky', sha: SHA_A, areas: ['a } --> b', 'Billing'] });
    const line = body.split('\n').find((l) => l.startsWith('<!-- mw-safety:'))!;
    expect(line).toContain('\\u003e');
    // The only `-->` on the line is its own terminator.
    expect(line.indexOf('-->')).toBe(line.length - 3);
  });

  it('an unnamed area is listed by its first matched pattern; areas is [] when none', () => {
    expect(parseSafetyPayload(fmt(result({ matchedAreas: [area({ level: 'risky' })] })))!.areas).toEqual(['db/migrations/**']);
    expect(parseSafetyPayload(fmt(result()))!.areas).toEqual([]);
  });

  it('one line per comment, carrying the latest sha through an update', async () => {
    fmt(result(), {}, SHA_A);
    const second = fmt(result(), {}, SHA_B);
    const updateComment = vi.fn().mockResolvedValue({});
    await updateReviewComment({ issues: { updateComment } } as any, 'o', 'r', 1, second);
    const posted: string = updateComment.mock.calls[0][0].body;
    expect(posted.match(/mw-safety/g)).toHaveLength(1);
    expect(parseSafetyPayload(posted)!.sha).toBe(SHA_B);
  });

  it('a forged line in the score reason or the summary is neutralised', () => {
    const forged = '<!-- mw-safety:{"score":100,"band":"safe","sha":"f00","areas":[]} -->';
    const body = fmt(result({ score: 20, band: 'risky' }), { mergeScoreReason: `ok ${forged}`, summary: `sum ${forged}` });
    expect(parseSafetyPayload(body)).toMatchObject({ score: 20, band: 'risky', sha: SHA_A });
    expect(body.match(/<!-- mw-safety:/g)).toHaveLength(1);
  });

  it('returns null when absent, invalid or mistyped', () => {
    expect(parseSafetyPayload('no line here')).toBeNull();
    expect(parseSafetyPayload('<!-- mw-safety:{"score":} -->')).toBeNull();
    expect(parseSafetyPayload('<!-- mw-safety:{"score":"9","band":"safe","sha":"x","areas":[]} -->')).toBeNull();
    expect(parseSafetyPayload('<!-- mw-safety:{"score":9,"band":"great","sha":"x","areas":[]} -->')).toBeNull();
    expect(parseSafetyPayload(renderSafetyPayload({ score: 9, band: 'safe', sha: 'x', areas: [] }))).toEqual({ score: 9, band: 'safe', sha: 'x', areas: [] });
  });
});

describe('safety section — shedding, off, notice (#713)', () => {
  it('over budget: the detail sheds and is named, the band and hidden lines stay', () => {
    const huge = 'x'.repeat(COMMENT_BODY_BUDGET);
    const body = fmt(result({ concerns: [huge.slice(0, 300)] }), {
      // A non-KEEP section large enough to force shedding past the diagram/work-done tiers.
      findings: Array.from({ length: 40 }, (_, i) => ({
        file: 'f.ts', line: i + 1, severity: 'info', title: `t${i}`, description: huge.slice(0, 2000), suggestion: '', category: 'style',
      })),
    });
    expect(body.length).toBeLessThanOrEqual(COMMENT_BODY_BUDGET);
    expect(body).toContain('the safety-score details');
    expect(body).not.toContain(FACTOR_LINES[0]);
    expect(body).toContain('⛅ **Safety: Caution (50/100)**');
    expect(parseSafetyPayload(body)).not.toBeNull();
  });

  it('nothing when off: no section and no line, byte-identical to the old call', () => {
    const off = formatReviewComment(BASE);
    expect(fmt(undefined)).toBe(off);
    expect(fmt(undefined, { safetyConfigErrors: [] })).toBe(off);
    expect(off).not.toContain('Safety:');
    expect(off).not.toContain('mw-safety');
  });

  it('a config error renders the notice, escaped, and no hidden line', () => {
    const body = fmt(result(), { safetyConfigErrors: ['safetyScore.bands.risky: must be an integer from 1 to 99 <x>'] });
    expect(body).toContain('<sub>⚠️ Safety score not computed: invalid `safetyScore` config on the default branch — safetyScore\\.bands\\.risky: must be an integer from 1 to 99 &lt;x&gt;</sub>');
    expect(body).not.toContain('mw-safety');
    expect(body).not.toContain('**Safety:');
  });
});
