import { describe, it, expect } from 'vitest';
import { TraceRecorder, outcomeKey, type TraceableFinding, buildReviewTrace, MAX_TRACE_OUTCOMES, isUsableOutcome, usableOutcomes, type FindingOutcome } from './filter-trace.js';

function f(over: Partial<TraceableFinding> = {}): TraceableFinding {
  return {
    file: 'src/db.ts', line: 10, severity: 'critical',
    confidence: 90, title: 'SQL injection', ...over,
  };
}

describe('outcomeKey', () => {
  it('prefers the fingerprint form when one exists', () => {
    expect(outcomeKey(f({ fingerprint: 'abc' }))).toBe('src/db.ts::F::abc');
  });

  it('falls back to the title form', () => {
    expect(outcomeKey(f())).toBe('src/db.ts::T::SQL injection');
  });
});

describe('TraceRecorder', () => {
  it('records one row per finding, with its agent', () => {
    const t = new TraceRecorder();
    t.enter(f(), 'security');
    t.finalize([f()]);
    const [o] = t.outcomes();
    expect(o.outcome).toBe('surfaced');
    expect(o.agents).toEqual(['security']);
  });

  it('collapses the same finding from two agents into one row with both', () => {
    // Pre-FP-C convergence: this is the only point where it is knowable, since
    // the merge downstream destroys the per-agent attribution.
    const t = new TraceRecorder();
    t.enter(f(), 'security');
    t.enter(f(), 'bugs');
    expect(t.outcomes()).toHaveLength(1);
    expect(t.outcomes()[0].agents).toEqual(['security', 'bugs']);
  });

  it('distinguishes demoted from dropped', () => {
    const t = new TraceRecorder();
    t.enter(f({ title: 'A' }), 'security');
    t.enter(f({ title: 'B' }), 'security');
    t.record(f({ title: 'A' }), 'dropped', 'confidence-floor', { reason: 'low' });
    t.record(f({ title: 'B' }), 'demoted', 'grounding', { reason: 'anchor unconfirmed' });
    const by = Object.fromEntries(t.outcomes().map((o) => [o.title, o]));
    expect(by.A.outcome).toBe('dropped');
    expect(by.B.outcome).toBe('demoted');
    expect(by.B.stage).toBe('grounding');
  });

  it('follows a survivor across a merge rename via alias()', () => {
    // FP-C and W10 both rewrite the primary's title. Without the alias the
    // survivor would look like a different finding and the ledger would split
    // into an orphan row and a ghost row.
    const t = new TraceRecorder();
    const before = f({ title: 'Original' });
    const after = f({ title: 'Original — and 2 related concerns' });
    t.enter(before, 'security');
    t.alias(outcomeKey(before), outcomeKey(after));
    t.finalize([after]);
    const rows = t.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Original');
    expect(rows[0].outcome).toBe('surfaced');
  });

  it('survives a second rename (FP-C then W10)', () => {
    const t = new TraceRecorder();
    const a = f({ title: 'One' });
    const b = f({ title: 'One — and 1 related cross-agent concern' });
    const c = f({ title: 'One — and 1 related cross-agent concern — and 2 related concerns' });
    t.enter(a, 'security');
    t.alias(outcomeKey(a), outcomeKey(b));
    t.alias(outcomeKey(b), outcomeKey(c));
    t.finalize([c]);
    expect(t.outcomes()).toHaveLength(1);
    expect(t.outcomes()[0].outcome).toBe('surfaced');
  });

  it('records the key a merged finding folded into', () => {
    const t = new TraceRecorder();
    const primary = f({ title: 'Primary' });
    const sibling = f({ title: 'Sibling', line: 11 });
    t.enter(primary, 'security');
    t.enter(sibling, 'bugs');
    t.record(sibling, 'merged', 'w10-clustering', { mergedInto: outcomeKey(primary) });
    const row = t.outcomes().find((o) => o.title === 'Sibling')!;
    expect(row.outcome).toBe('merged');
    expect(row.mergedInto).toBe('src/db.ts::T::Primary');
  });

  it('first verdict wins — a later stage cannot rewrite history', () => {
    const t = new TraceRecorder();
    t.enter(f(), 'security');
    t.record(f(), 'dropped', 'confidence-floor', { reason: 'first' });
    t.record(f(), 'surfaced');
    const [o] = t.outcomes();
    expect(o.outcome).toBe('dropped');
    expect(o.reason).toBe('first');
  });

  it('registers an unknown key rather than dropping the row silently', () => {
    // The orchestrator can return a finding whose title it reworded. A ledger
    // that ignored those rows would be lying by omission.
    const t = new TraceRecorder();
    t.record(f({ title: 'Reworded by the orchestrator' }), 'surfaced');
    expect(t.outcomes()).toHaveLength(1);
    expect(t.outcomes()[0].agents).toEqual(['orchestrator']);
  });

  it('derives suppressedCount as everything that did not surface', () => {
    const t = new TraceRecorder();
    for (const title of ['a', 'b', 'c', 'd']) t.enter(f({ title }), 'security');
    t.record(f({ title: 'a' }), 'dropped', 'confidence-floor');
    t.record(f({ title: 'b' }), 'merged', 'w10-clustering');
    t.record(f({ title: 'c' }), 'demoted', 'grounding');
    t.finalize([f({ title: 'd' })]);
    // Demoted counts as suppressed-from-the-rendered-set only in the sense
    // that it did not surface unchanged; the ledger keeps the distinction.
    expect(t.suppressedCount()).toBe(3);
  });

  it('leaves an unadjudicated entry visible as dropped with no stage', () => {
    // A stage that forgets to record must surface as a wiring bug, not be
    // quietly balanced away.
    const t = new TraceRecorder();
    t.enter(f(), 'security');
    const [o] = t.outcomes();
    expect(o.outcome).toBe('dropped');
    expect(o.stage).toBeUndefined();
  });
});

describe('TraceRecorder — dangling alias (#478 review)', () => {
  // An orchestrator rewrite that a merge stage then renames produces an alias
  // whose TARGET never entered the ledger. The fallback in record() must key
  // off the finding itself, not the resolved key: the resolved key has no row,
  // so reading it back would hand `undefined` to a non-null assertion and
  // throw on exactly the path the fallback exists to handle.
  it('handles an alias pointing at a row that never entered', () => {
    const t = new TraceRecorder();
    const reworded = f({ title: 'Reworded by the orchestrator' });
    const merged = f({ title: 'Reworded by the orchestrator — and 1 related concern' });

    t.alias(outcomeKey(reworded), outcomeKey(merged));   // target never entered
    expect(() => t.record(merged, 'surfaced')).not.toThrow();

    const rows = t.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('surfaced');
  });

  it('does not create a duplicate row when the same finding is recorded twice through a dangling alias', () => {
    const t = new TraceRecorder();
    const reworded = f({ title: 'Reworded' });
    const merged = f({ title: 'Reworded — and 1 related concern' });

    t.alias(outcomeKey(reworded), outcomeKey(merged));
    t.record(merged, 'dropped', 'confidence-floor', { reason: 'first' });
    t.record(merged, 'surfaced');

    const rows = t.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('dropped');   // first verdict still wins
    expect(rows[0].reason).toBe('first');
  });

  it('still resolves through an alias whose target DID enter', () => {
    // The ordinary case must keep working — this is the one the fallback is
    // not involved in at all.
    const t = new TraceRecorder();
    const before = f({ title: 'Original' });
    const after = f({ title: 'Original — and 1 related concern' });
    t.enter(before, 'security');
    t.alias(outcomeKey(before), outcomeKey(after));
    t.record(after, 'surfaced');

    const rows = t.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Original');
    expect(rows[0].agents).toEqual(['security']);
  });
});

describe('TraceRecorder — alias chain termination (#478 review)', () => {
  it('terminates on a cyclic alias chain instead of walking a fixed bound', () => {
    const t = new TraceRecorder();
    const a = f({ title: 'A' });
    const b = f({ title: 'B' });
    t.enter(a, 'security');
    // Force a cycle directly — the pipeline only ever renames forward, but the
    // recorder should not depend on its one caller behaving.
    t.alias(outcomeKey(a), outcomeKey(b));
    t.alias(outcomeKey(b), outcomeKey(a));
    expect(() => t.record(b, 'surfaced')).not.toThrow();
    expect(t.outcomes().length).toBeGreaterThan(0);
  });

  it('resolves a three-link chain to the original row', () => {
    const t = new TraceRecorder();
    const one = f({ title: 'One' });
    const two = f({ title: 'Two' });
    const three = f({ title: 'Three' });
    t.enter(one, 'security');
    t.alias(outcomeKey(one), outcomeKey(two));
    t.alias(outcomeKey(two), outcomeKey(three));
    t.record(three, 'surfaced');
    const rows = t.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('One');
  });
});

describe('buildReviewTrace (#471)', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');

  function outcomes(n: number, outcome: 'surfaced' | 'dropped'): FindingOutcome[] {
    return Array.from({ length: n }, (_, i) => ({
      key: `src/a.ts::T::${outcome}-${i}`,
      file: 'src/a.ts', line: i + 1, severity: 'warning' as const,
      title: `${outcome}-${i}`, agents: ['security'], outcome,
    }));
  }

  it('keys the trace exactly as the review — no suffix', () => {
    // A suffix is what would collide: queryByPR matches begins_with("42#"), so
    // `42#abc123#TRACE` on the reviews table is returned as a review.
    const t = buildReviewTrace('o/r', '42#abc123', [], NOW);
    expect(t.repoFullName).toBe('o/r');
    expect(t.prNumberCommitSha).toBe('42#abc123');
  });

  it('sets a 30-day TTL', () => {
    const t = buildReviewTrace('o/r', '42#abc', [], NOW);
    expect(t.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 30 * 24 * 60 * 60);
  });

  it('does not mark an under-cap trace as truncated', () => {
    const t = buildReviewTrace('o/r', '42#abc', outcomes(10, 'dropped'), NOW);
    expect(t.truncated).toBeUndefined();
    expect(t.totalOutcomes).toBeUndefined();
    expect(t.outcomes).toHaveLength(10);
  });

  it('caps the retained outcomes and says so', () => {
    // #401's runaway emitted ~1,430 near-empty findings from one response.
    const t = buildReviewTrace('o/r', '42#abc', outcomes(1_430, 'dropped'), NOW);
    expect(t.outcomes).toHaveLength(MAX_TRACE_OUTCOMES);
    expect(t.truncated).toBe(true);
    expect(t.totalOutcomes).toBe(1_430);
  });

  it('keeps the explanatory outcomes when truncating', () => {
    // Surfaced findings are already visible in the PR comment; the dropped and
    // merged ones are the only thing the trace adds, so those are what a
    // truncated trace must retain to still be worth reading.
    const mixed = [...outcomes(400, 'surfaced'), ...outcomes(400, 'dropped')];
    const t = buildReviewTrace('o/r', '42#abc', mixed, NOW);
    expect(t.outcomes).toHaveLength(MAX_TRACE_OUTCOMES);
    expect(t.outcomes.filter((o) => o.outcome === 'dropped')).toHaveLength(400);
    expect(t.truncated).toBe(true);
    expect(t.totalOutcomes).toBe(800);
  });

  it('handles an empty ledger', () => {
    const t = buildReviewTrace('o/r', '42#abc', [], NOW);
    expect(t.outcomes).toEqual([]);
    expect(t.truncated).toBeUndefined();
  });
});

describe('no undefined values in the ledger (#471 prod bug)', () => {
  // DynamoDB's marshaller rejects undefined outright:
  //   "Pass options.removeUndefinedValues=true to remove undefined values"
  // Emitting them made every trace write fail for any review with a
  // non-trivial ledger — silently, because the write is best-effort by design.
  function assertNoUndefined(rows: object[]) {
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        expect(v, `${k} must be omitted, not undefined`).not.toBeUndefined();
      }
    }
  }

  it('omits stage, reason and mergedInto when absent', () => {
    const t = new TraceRecorder();
    t.enter(f({ confidence: undefined }), 'security');
    t.finalize([f({ confidence: undefined })]);
    const rows = t.outcomes();
    expect('stage' in rows[0]).toBe(false);
    expect('reason' in rows[0]).toBe(false);
    expect('mergedInto' in rows[0]).toBe(false);
    expect('confidence' in rows[0]).toBe(false);
    assertNoUndefined(rows);
  });

  it('keeps them when present', () => {
    const t = new TraceRecorder();
    t.enter(f(), 'security');
    t.record(f(), 'merged', 'w10-clustering', { reason: 'r', mergedInto: 'k' });
    const [row] = t.outcomes();
    expect(row.stage).toBe('w10-clustering');
    expect(row.reason).toBe('r');
    expect(row.mergedInto).toBe('k');
    expect(row.confidence).toBe(90);
  });

  it('emits nothing undefined for an unadjudicated entry either', () => {
    // The wiring-gap row is the one most likely to be sparse.
    const t = new TraceRecorder();
    t.enter(f({ confidence: undefined }), 'security');
    assertNoUndefined(t.outcomes());
  });

  it('a full trace round-trips through JSON unchanged', () => {
    // A cheap proxy for marshalling: JSON.stringify silently drops undefined,
    // so a mismatch here means undefined was present.
    const t = new TraceRecorder();
    t.enter(f({ title: 'a', confidence: undefined }), 'security');
    t.enter(f({ title: 'b' }), 'bugs');
    t.record(f({ title: 'b' }), 'dropped', 'confidence-floor', { reason: 'low' });
    t.finalize([f({ title: 'a', confidence: undefined })]);
    const rows = t.outcomes();
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });
});

describe('isUsableOutcome / usableOutcomes (#482 review)', () => {
  const good = {
    key: 'k', file: 'a.ts', line: 1, severity: 'warning',
    title: 't', agents: ['security'], outcome: 'dropped',
  };

  it('accepts a well-formed row', () => {
    expect(isUsableOutcome(good)).toBe(true);
  });

  it('rejects a row with no agents — the renderer calls agents.join()', () => {
    // `e.agents.length` throws outright on this, which Array.isArray on the
    // container could never catch.
    const { agents, ...noAgents } = good;
    expect(isUsableOutcome(noAgents)).toBe(false);
  });

  it('rejects rows missing the fields the renderer dereferences', () => {
    for (const field of ['key', 'file', 'title', 'line', 'outcome']) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[field];
      expect(isUsableOutcome(bad), `missing ${field}`).toBe(false);
    }
  });

  it('rejects an unknown outcome value', () => {
    expect(isUsableOutcome({ ...good, outcome: 'exploded' })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 42, []]) expect(isUsableOutcome(v)).toBe(false);
  });

  it('keeps good rows and reports the original total', () => {
    // Losing one corrupt row should not cost the reader the other ninety-nine.
    const { outcomes, total } = usableOutcomes([good, {}, { ...good, key: 'k2' }]);
    expect(outcomes).toHaveLength(2);
    expect(total).toBe(3);
  });

  it('reports total === length when nothing was lost', () => {
    const { outcomes, total } = usableOutcomes([good]);
    expect(outcomes).toHaveLength(1);
    expect(total).toBe(1);
  });
});

describe('#594 — a cross-agent representative is recorded as surfaced, not merged', () => {
  const f = (title: string, over: Partial<TraceableFinding> = {}): TraceableFinding => ({
    file: 'src/admin-endpoint.ts',
    line: 4,
    title,
    severity: 'critical',
    confidence: 95,
    ...over,
  }) as TraceableFinding;

  it('does not spend a row\'s terminal verdict on a merge into itself', () => {
    // The exact shape from mergewatch/fixtures#2550: three agents independently
    // raise the SAME title, so enter() files them under one row. FP-C then
    // merges them and hands back a renamed representative.
    const t = new TraceRecorder();
    const finding = f('Missing authorization check for admin endpoint');
    for (const agent of ['security', 'bug', 'test-coverage']) t.enter(finding, agent);

    const primaryAfter = f('Missing authorization check for admin endpoint — and 2 related cross-agent concerns');
    const into = outcomeKey(primaryAfter);
    t.alias(outcomeKey(finding), into);
    // The absorbed sibling shares the representative's row by design.
    t.record(finding, 'merged', 'fp-c-line-dedup', { mergedInto: into });

    t.finalize([primaryAfter]);

    const outs = t.outcomes();
    expect(outs).toHaveLength(1);
    // Before the fix this was 'merged': a finding the reader SAW, filed as
    // merged away, with no way for a later stage to correct it.
    expect(outs[0].outcome).toBe('surfaced');
  });

  it('still records a genuine absorption of a different finding', () => {
    const t = new TraceRecorder();
    const rep = f('Missing authorization check for admin endpoint');
    const other = f('Admin endpoint lacks authorization check');
    t.enter(rep, 'security');
    t.enter(other, 'bug');

    const primaryAfter = f('Missing authorization check for admin endpoint — and 1 related concern');
    const into = outcomeKey(primaryAfter);
    t.alias(outcomeKey(rep), into);
    t.record(other, 'merged', 'fp-c-line-dedup', { mergedInto: into });
    t.finalize([primaryAfter]);

    const byTitle = Object.fromEntries(t.outcomes().map((o) => [o.title, o.outcome]));
    expect(byTitle['Admin endpoint lacks authorization check']).toBe('merged');
    expect(byTitle['Missing authorization check for admin endpoint']).toBe('surfaced');
  });

  it('lets a stage after the merge record that it dropped the representative', () => {
    // The other half of the same defect: with the row's verdict spent on a
    // self-merge, a later drop was unrecordable — so a critical could vanish
    // between clustering and the comment with nothing in the ledger to explain it.
    const t = new TraceRecorder();
    const finding = f('Missing authorization check for admin endpoint');
    t.enter(finding, 'security');
    t.enter(finding, 'bug');

    const primaryAfter = f('Missing authorization check for admin endpoint — and 1 related concern');
    const into = outcomeKey(primaryAfter);
    t.alias(outcomeKey(finding), into);
    t.record(finding, 'merged', 'fp-c-line-dedup', { mergedInto: into });

    t.record(primaryAfter, 'dropped', 'finding-verify', { reason: 'verifier refuted it' });

    const outs = t.outcomes();
    expect(outs).toHaveLength(1);
    expect(outs[0].outcome).toBe('dropped');
    expect(outs[0].stage).toBe('finding-verify');
  });
});

describe('#594 second half — `surfaced` is authoritative for a row', () => {
  const f = (title: string, over: Partial<TraceableFinding> = {}): TraceableFinding => ({
    file: 'src/admin-endpoint.ts',
    line: 4,
    title,
    severity: 'critical',
    confidence: 95,
    ...over,
  }) as TraceableFinding;

  it('reports a rendered finding as surfaced even when a same-keyed sibling was dropped', () => {
    // mergewatch/fixtures#2597: the orchestrator dropped one instance as a
    // duplicate; another survived, was renamed by FP-C, and aliased back to
    // the same row. The row read `dropped` for a critical the reader SAW.
    const t = new TraceRecorder();
    const base = f('Missing authorization check for admin endpoint');
    t.enter(base, 'security');
    t.enter(base, 'bug');

    t.record(base, 'dropped', 'orchestrator', { reason: 'duplicate of a stronger finding' });

    const renamed = f('Missing authorization check for admin endpoint — and 6 related cross-agent concerns');
    t.alias(outcomeKey(base), outcomeKey(renamed));
    t.finalize([renamed]);

    // Two instances, two fates, two rows — the drop keeps its reasoning and
    // the rendered finding is recorded as what the reader saw.
    const outs = t.outcomes();
    expect(outs).toHaveLength(2);
    const by = Object.fromEntries(outs.map((o) => [o.outcome, o]));
    expect(by.surfaced).toBeTruthy();
    expect(by.dropped.stage).toBe('orchestrator');
    expect(by.dropped.reason).toBe('duplicate of a stronger finding');
  });

  it('still refuses to let one filter rewrite another filter\'s verdict', () => {
    // Only `surfaced` is a fact about the published comment. Everything else
    // is a stage's opinion and keeps first-verdict-wins.
    const t = new TraceRecorder();
    const finding = f('Missing authorization check for admin endpoint');
    t.enter(finding, 'security');
    t.record(finding, 'dropped', 'confidence-floor', { reason: 'below floor' });
    t.record(finding, 'dropped', 'min-severity', { reason: 'under threshold' });

    const outs = t.outcomes();
    expect(outs[0].stage).toBe('confidence-floor');
    expect(outs[0].reason).toBe('below floor');
  });

  it('does not let a later drop overwrite a surfaced row', () => {
    const t = new TraceRecorder();
    const finding = f('Missing authorization check for admin endpoint');
    t.enter(finding, 'security');
    t.record(finding, 'surfaced');
    t.record(finding, 'dropped', 'min-severity', { reason: 'late' });

    expect(t.outcomes()).toHaveLength(1);
    expect(t.outcomes()[0].outcome).toBe('surfaced');
  });
});
