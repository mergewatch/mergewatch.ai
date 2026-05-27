import { describe, it, expect } from 'vitest';
import {
  SECURITY_REVIEWER_PROMPT,
  BUG_REVIEWER_PROMPT,
  STYLE_REVIEWER_PROMPT,
  SUMMARY_PROMPT,
  DIAGRAM_PROMPT,
  ORCHESTRATOR_PROMPT,
  ERROR_HANDLING_REVIEWER_PROMPT,
  TEST_COVERAGE_REVIEWER_PROMPT,
  COMMENT_ACCURACY_REVIEWER_PROMPT,
  TONE_DIRECTIVES,
  TONE_PLACEHOLDER,
  CUSTOM_AGENT_RESPONSE_FORMAT,
} from './prompts.js';

// ─── Prompt constants are non-empty strings ─────────────────────────────────

describe('prompt constants are non-empty strings', () => {
  const prompts: Record<string, string> = {
    SECURITY_REVIEWER_PROMPT,
    BUG_REVIEWER_PROMPT,
    STYLE_REVIEWER_PROMPT,
    SUMMARY_PROMPT,
    DIAGRAM_PROMPT,
    ORCHESTRATOR_PROMPT,
    ERROR_HANDLING_REVIEWER_PROMPT,
    TEST_COVERAGE_REVIEWER_PROMPT,
    COMMENT_ACCURACY_REVIEWER_PROMPT,
  };

  for (const [name, value] of Object.entries(prompts)) {
    it(`${name} is a non-empty string`, () => {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    });
  }
});

// ─── Placeholder presence ───────────────────────────────────────────────────

describe('placeholder presence in prompts', () => {
  it('SECURITY_REVIEWER_PROMPT contains FILE_REQUEST_PLACEHOLDER', () => {
    expect(SECURITY_REVIEWER_PROMPT).toContain('FILE_REQUEST_PLACEHOLDER');
  });

  it('BUG_REVIEWER_PROMPT contains FILE_REQUEST_PLACEHOLDER', () => {
    expect(BUG_REVIEWER_PROMPT).toContain('FILE_REQUEST_PLACEHOLDER');
  });

  it('STYLE_REVIEWER_PROMPT contains CUSTOM_RULES_PLACEHOLDER', () => {
    expect(STYLE_REVIEWER_PROMPT).toContain('CUSTOM_RULES_PLACEHOLDER');
  });

  it('ORCHESTRATOR_PROMPT contains MAX_FINDINGS_PLACEHOLDER', () => {
    expect(ORCHESTRATOR_PROMPT).toContain('MAX_FINDINGS_PLACEHOLDER');
  });
});

// ─── Tone directives ────────────────────────────────────────────────────────

describe('TONE_DIRECTIVES', () => {
  it('has entries for collaborative, direct, and advisory', () => {
    expect(TONE_DIRECTIVES).toHaveProperty('collaborative');
    expect(TONE_DIRECTIVES).toHaveProperty('direct');
    expect(TONE_DIRECTIVES).toHaveProperty('advisory');
    expect(typeof TONE_DIRECTIVES.collaborative).toBe('string');
    expect(typeof TONE_DIRECTIVES.direct).toBe('string');
    expect(typeof TONE_DIRECTIVES.advisory).toBe('string');
  });
});

// ─── Agent prompts contain TONE_PLACEHOLDER ─────────────────────────────────

describe('agent prompts contain TONE_PLACEHOLDER', () => {
  const agentPrompts: Record<string, string> = {
    SECURITY_REVIEWER_PROMPT,
    BUG_REVIEWER_PROMPT,
    STYLE_REVIEWER_PROMPT,
    ERROR_HANDLING_REVIEWER_PROMPT,
    TEST_COVERAGE_REVIEWER_PROMPT,
    COMMENT_ACCURACY_REVIEWER_PROMPT,
  };

  for (const [name, value] of Object.entries(agentPrompts)) {
    it(`${name} contains TONE_PLACEHOLDER`, () => {
      expect(value).toContain(TONE_PLACEHOLDER);
    });
  }
});

// ─── CUSTOM_AGENT_RESPONSE_FORMAT ───────────────────────────────────────────

describe('CUSTOM_AGENT_RESPONSE_FORMAT', () => {
  it('contains "findings" in its schema', () => {
    expect(CUSTOM_AGENT_RESPONSE_FORMAT).toContain('findings');
  });
});

// ─── Restraint principles (shared preamble) ────────────────────────────────
//
// These tests lock in the anti-pedantry / anti-nit-picking instructions
// that the SHARED_PREAMBLE injects into every finding-producing agent.
// They guard against a future edit that softens the bar back toward
// "extract this helper" / "magic number" / "consider renaming" findings.
// User-facing complaint surface: bot piles up refactor-suggestion noise
// that drowns out real defects, training authors to ignore the bot.

describe('shared preamble — restraint principles', () => {
  // All finding-producing agents share the preamble, so checking any one
  // of them is sufficient — pick STYLE_REVIEWER_PROMPT since it's the
  // most-affected surface.
  const sharedPreambleSurface = STYLE_REVIEWER_PROMPT;

  it('declares the senior-reviewer gut check', () => {
    expect(sharedPreambleSurface).toMatch(/senior.{0,30}gut check/i);
    expect(sharedPreambleSurface).toMatch(/(would a thoughtful senior|substantive findings beat)/i);
  });

  it('forbids "Consider extracting" and similar refactor-suggestion findings', () => {
    expect(sharedPreambleSurface).toMatch(/Consider extracting/);
    expect(sharedPreambleSurface).toMatch(/Magic number/);
    expect(sharedPreambleSurface).toMatch(/Refactor suggestions are NOT findings/i);
  });

  it('declares the defects-not-improvements distinction', () => {
    expect(sharedPreambleSurface).toMatch(/Defects, not improvements/i);
  });

  it('declares scope discipline (only flag what the PR introduces)', () => {
    expect(sharedPreambleSurface).toMatch(/Scope discipline/i);
    expect(sharedPreambleSurface).toMatch(/this PR INTRODUCES/);
  });

  it('declares the "when in doubt, omit" principle', () => {
    expect(sharedPreambleSurface).toMatch(/When in doubt, OMIT/);
  });
});

// ─── Style agent — hard-list DO NOT report items ────────────────────────────

describe('STYLE_REVIEWER_PROMPT — hard-list nit blocklist', () => {
  // Lock in the concrete patterns the bot has historically over-fired on.
  // Each of these has appeared in real MergeWatch reviews as a low-value
  // "finding" that the author had to dismiss.
  const nitPatternsToBlock = [
    /Magic numbers? \/ "should be a named constant"/i,
    /Consider extracting this into a helper/i,
    /Consider consolidating these comments/i,
    /Magic string could be extracted as a constant/i,
    /Could be more idiomatic/i,
    /Consider renaming X for clarity/i,
    /Deep nesting.{0,50}structural preferences/i,
    /Missing or incomplete JSDoc/i,
  ];

  for (const pat of nitPatternsToBlock) {
    it(`explicitly forbids the pattern: ${pat}`, () => {
      expect(STYLE_REVIEWER_PROMPT).toMatch(pat);
    });
  }

  it('caps severity at "warning" only for measurable correctness/performance issues', () => {
    expect(STYLE_REVIEWER_PROMPT).toMatch(/cap at "warning" only when/i);
    expect(STYLE_REVIEWER_PROMPT).toMatch(/Most findings from this agent should be "info" or nothing at all/i);
  });
});

// ─── Comment-accuracy agent — TODO scope removed ────────────────────────────

describe('COMMENT_ACCURACY_REVIEWER_PROMPT — TODO scope removed', () => {
  it('explicitly excludes stale TODOs from scope', () => {
    expect(COMMENT_ACCURACY_REVIEWER_PROMPT).toMatch(/TODOs are never findings/i);
  });

  it('narrows the scope to comments that make a specific factual claim the diff contradicts', () => {
    expect(COMMENT_ACCURACY_REVIEWER_PROMPT).toMatch(/SPECIFIC FACTUAL CLAIM/i);
  });

  it('does NOT instruct flagging "Comments describing logic that was changed" generically', () => {
    // The previous shape was "Comments describing logic that was changed in
    // this diff but the comment was not updated" — too broad, fired on
    // every refactor. New shape requires the comment to make a falsifiable
    // claim. This test pins that the looser phrasing is gone.
    expect(COMMENT_ACCURACY_REVIEWER_PROMPT).not.toMatch(
      /Comments describing logic that was changed in this diff but the comment was not updated/,
    );
  });
});

// ─── Test-coverage agent — high-consequence path gate ──────────────────────

describe('TEST_COVERAGE_REVIEWER_PROMPT — high-consequence path gate', () => {
  it('requires the change to be in a high-consequence path to warrant a missing-test finding', () => {
    expect(TEST_COVERAGE_REVIEWER_PROMPT).toMatch(/HIGH-CONSEQUENCE path/i);
    expect(TEST_COVERAGE_REVIEWER_PROMPT).toMatch(/auth.{0,20}authz.{0,20}data integrity/i);
  });

  it('explicitly excludes trivial code (getters, passthroughs, type-only)', () => {
    expect(TEST_COVERAGE_REVIEWER_PROMPT).toMatch(/getters.{0,30}passthroughs/i);
  });

  it('caps "critical" severity to the rare immediate-production-failure case', () => {
    expect(TEST_COVERAGE_REVIEWER_PROMPT).toMatch(/"critical" is almost never appropriate/i);
  });
});

// ─── Orchestrator — anti-pedantry pass ─────────────────────────────────────

describe('ORCHESTRATOR_PROMPT — anti-pedantry pass', () => {
  it('includes an explicit anti-pedantry filter step', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/Anti-pedantry pass/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/let it slide/i);
  });

  it('lists the concrete refactor-suggestion patterns to drop', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/Consider extracting/);
    expect(ORCHESTRATOR_PROMPT).toMatch(/Magic number could be a constant/);
    expect(ORCHESTRATOR_PROMPT).toMatch(/Consider consolidating/);
  });

  it('explicitly argues for fewer-but-substantive findings over a longer list with nits', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/0-3 substantive findings beats a 6-finding review with 4 nits/i);
  });
});
