import { describe, it, expect } from 'vitest';
import { TraceRecorder, outcomeKey, type TraceableFinding } from './filter-trace.js';

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
