/**
 * #470 — the filter outcome ledger.
 *
 * Twelve stages in `runReviewPipeline` can delete, merge, or demote a finding.
 * Every one announced its decision to `console.warn` and nowhere else, and
 * what survived to the reader was a single scalar:
 *
 *     suppressedCount: Math.max(0, totalRawFindings - filteredFindings.length)
 *
 * rendered as "13 findings removed by dedup & quality filters". No way to
 * learn which thirteen, why, or whether the one thing you were worried about
 * was among them.
 *
 * A bare count is not merely uninformative — #401 shipped because two
 * production reviews reported "1430" and "3869 findings removed by dedup &
 * quality filters" on 4-line diffs. That was a malfunctioning agent's junk,
 * faithfully described as productive filtering. The fix there was to stop
 * counting junk; the deeper problem is that a count cannot distinguish good
 * filtering from a malfunction at all. This records the decisions themselves.
 *
 * In-memory and core-only. #471 persists it; #472 renders it.
 */

/** The stages that can remove, merge, or demote a finding. */
export type FilterStage =
  | 'fp-c-line-dedup'       // cross-agent same (file,line) merge
  | 'orchestrator'          // LLM dedup / rank / maxFindings cap
  | 'w10-clustering'        // same-region consolidation
  | 'confidence-floor'      // FP-A
  | 'min-severity'          // #310
  | 'w11-scope-awareness'   // no-test-harness collapse
  | 'grounding'             // anchor / identifier / no-op-suggestion
  | 'fp-i-already-applied'  // suggestion byte-equals existing code
  | 'finding-verify'        // W2 / FP-E verifier verdict
  | 'line-proximity'        // ±3 changed-line filter
  | 'custom-agent-dedup'    // #385 re-entry
  | 'triage-suppressed';    // W3

/**
 * What happened to one finding in one review.
 *
 * `demoted` is a distinct outcome, not a flavour of `dropped`: grounding and
 * the verifier both demote criticals to `unverified` rather than deleting them
 * (#385), and that decision was previously invisible.
 */
export interface FindingOutcome {
  /** W9 identity — `file::F::<fingerprint>` when available, else `file::T::<title>`. */
  key: string;
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence?: number;
  title: string;
  /** Every agent that independently emitted this, pre-FP-C merge. */
  agents: string[];
  outcome: 'surfaced' | 'merged' | 'dropped' | 'demoted';
  stage?: FilterStage;
  reason?: string;
  /** For `merged`: the key it folded into. */
  mergedInto?: string;
}

/** The minimum shape the recorder needs off a finding. */
export interface TraceableFinding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence?: number;
  title: string;
  fingerprint?: string;
}

/**
 * W9 identity for a finding, preferring the fingerprint form. Mirrors
 * `findingMatchKeys` in review-delta.ts, but returns the single strongest key
 * rather than the union: the ledger needs one identity per row, not a match set.
 */
export function outcomeKey(f: TraceableFinding): string {
  return f.fingerprint ? `${f.file}::F::${f.fingerprint}` : `${f.file}::T::${f.title}`;
}

interface Entry {
  key: string;
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence?: number;
  title: string;
  agents: Set<string>;
  outcome?: FindingOutcome['outcome'];
  stage?: FilterStage;
  reason?: string;
  mergedInto?: string;
}

/**
 * Accumulates one terminal outcome per finding that enters the pipeline.
 *
 * Identity is the problem this class exists to solve. Two stages rewrite a
 * surviving finding's title — FP-C's cross-agent merge and W10's clustering
 * both append "and N related concerns" — so a title-derived key changes
 * mid-flight. `alias()` records the rename so a later decision on the new key
 * resolves back to the row that entered, and the one-terminal-outcome
 * invariant holds across a merge instead of splitting into an orphan and a
 * ghost.
 *
 * Recording is idempotent-by-first-write: the first terminal outcome for a
 * finding wins. A stage cannot overwrite an earlier stage's verdict, so a
 * double-record is a no-op rather than a silent rewrite of history.
 */
export class TraceRecorder {
  private entries = new Map<string, Entry>();
  /** current key → entry key, for findings a merge stage renamed. */
  private aliases = new Map<string, string>();

  /** Register a finding as it enters the pipeline, attributed to its agent. */
  enter(f: TraceableFinding, agent: string): void {
    const key = outcomeKey(f);
    const existing = this.entries.get(key);
    if (existing) {
      // Same (file, title) from a second agent — one row, both agents. This is
      // the pre-FP-C convergence signal, and it must be captured here because
      // the merge downstream is what destroys it.
      existing.agents.add(agent);
      return;
    }
    this.entries.set(key, {
      key,
      file: f.file,
      line: f.line,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      agents: new Set([agent]),
    });
  }

  /** Resolve a possibly-renamed key back to the row that entered. */
  private resolve(key: string): string {
    let k = key;
    // Bounded walk: a finding can be renamed by FP-C and again by W10.
    for (let i = 0; i < 8 && this.aliases.has(k); i++) {
      k = this.aliases.get(k)!;
    }
    return k;
  }

  /**
   * Record that a surviving finding was renamed by a merge stage, so later
   * decisions about it still land on the row that entered.
   */
  alias(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    this.aliases.set(toKey, this.resolve(fromKey));
  }

  /**
   * Record a terminal outcome. Unknown keys register themselves first — the
   * orchestrator can return a finding whose title it reworded, and a ledger
   * that silently dropped those rows would be lying by omission.
   */
  record(
    f: TraceableFinding,
    outcome: FindingOutcome['outcome'],
    stage?: FilterStage,
    extra?: { reason?: string; mergedInto?: string },
  ): void {
    const key = this.resolve(outcomeKey(f));
    let e = this.entries.get(key);
    if (!e) {
      this.enter(f, 'orchestrator');
      // Read back the key `enter()` actually used, NOT the resolved one.
      // These differ when an alias points at a row that never entered — an
      // orchestrator rewrite that a merge stage then renamed. In that case the
      // resolved key is dangling and has no row, so looking it up here would
      // hand back `undefined` and the assertion below would throw on the very
      // path this fallback exists to handle.
      e = this.entries.get(outcomeKey(f))!;
    }
    // First verdict wins: a later stage never rewrites an earlier one's record.
    if (e.outcome) return;
    e.outcome = outcome;
    e.stage = stage;
    e.reason = extra?.reason;
    e.mergedInto = extra?.mergedInto;
  }

  /** Mark everything still un-adjudicated as surfaced. Call once, at the end. */
  finalize(surfaced: TraceableFinding[]): void {
    for (const f of surfaced) {
      this.record(f, 'surfaced');
    }
  }

  /** The ledger. */
  outcomes(): FindingOutcome[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      file: e.file,
      line: e.line,
      severity: e.severity,
      confidence: e.confidence,
      title: e.title,
      agents: [...e.agents],
      // An entry with no recorded verdict never reached a terminal stage. That
      // is a bug in the wiring, not a state to invent a value for — call it
      // dropped with no stage so the self-consistency test can see it.
      outcome: e.outcome ?? 'dropped',
      stage: e.stage,
      reason: e.reason,
      mergedInto: e.mergedInto,
    }));
  }

  /**
   * Findings removed from the rendered set, derived rather than subtracted.
   *
   * The old `totalRawFindings - filteredFindings.length` was measured upstream
   * of where #385's custom-agent findings re-enter, so it double-counted them.
   * Deriving it also means a stage that forgets to record shows up as a
   * mismatch instead of quietly balancing the books.
   */
  suppressedCount(): number {
    return this.outcomes().filter((o) => o.outcome !== 'surfaced').length;
  }
}
