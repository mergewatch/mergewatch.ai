import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeScoreToReviewEvent,
  buildInlineComments,
  extractInlineCommentTitle,
  extractInlineCommentFingerprint,
  BOT_COMMENT_MARKER,
  parseRepoConfigYaml,
  addPRReaction,
  removePRReaction,
  submitPRReview,
  findExistingBotComment,
  dismissStaleReviews,
  resolveAppLogin,
  __resetAppLoginCache,
} from './client.js';
import type { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// mergeScoreToReviewEvent
// ---------------------------------------------------------------------------

describe('mergeScoreToReviewEvent', () => {
  it('returns APPROVE for score 5', () => {
    expect(mergeScoreToReviewEvent(5)).toBe('APPROVE');
  });

  it('returns APPROVE for score 4', () => {
    expect(mergeScoreToReviewEvent(4)).toBe('APPROVE');
  });

  it('returns COMMENT for score 3', () => {
    expect(mergeScoreToReviewEvent(3)).toBe('COMMENT');
  });

  it('returns REQUEST_CHANGES for score 2', () => {
    expect(mergeScoreToReviewEvent(2)).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for score 1', () => {
    expect(mergeScoreToReviewEvent(1)).toBe('REQUEST_CHANGES');
  });

  it('returns APPROVE for scores above 5', () => {
    expect(mergeScoreToReviewEvent(6)).toBe('APPROVE');
  });

  it('returns REQUEST_CHANGES for scores below 1', () => {
    expect(mergeScoreToReviewEvent(0)).toBe('REQUEST_CHANGES');
  });
});

// ---------------------------------------------------------------------------
// buildInlineComments
// ---------------------------------------------------------------------------

describe('buildInlineComments', () => {
  const changedFiles = ['src/app.ts', 'src/utils.ts', 'README.md'];

  it('includes critical findings on changed files', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'SQL Injection', description: 'User input used directly in query', suggestion: 'Use parameterized queries' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/app.ts');
    expect(result[0].line).toBe(10);
    expect(result[0].side).toBe('RIGHT');
  });

  it('FP-F (#182) — embeds a base64 fingerprint marker that round-trips through extractInlineCommentFingerprint', () => {
    // Code text with chars that would break a raw HTML comment (`--`, `>`).
    const fp = "app.get('/admin', (req,res) => res.json(db.query('--x'))) // a-->b";
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'T', description: 'd', suggestion: '', fingerprint: fp },
    ];
    const [c] = buildInlineComments(findings, changedFiles);
    expect(c.body).toMatch(/<!-- mw-fp:[A-Za-z0-9+/=]+ -->/);
    // The marker survives the dangerous chars and decodes back exactly.
    expect(extractInlineCommentFingerprint(c.body)).toBe(fp);
    // The visible title still extracts cleanly alongside the hidden marker.
    expect(extractInlineCommentTitle(c.body)).toBe('T');
  });

  it('FP-F (#182) — omits the fingerprint marker when the finding has none', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'T', description: 'd', suggestion: '' },
    ];
    const [c] = buildInlineComments(findings, changedFiles);
    expect(c.body).not.toContain('mw-fp:');
    expect(extractInlineCommentFingerprint(c.body)).toBe('');
  });

  it('extractInlineCommentFingerprint returns empty for absent / malformed markers', () => {
    expect(extractInlineCommentFingerprint('no marker here')).toBe('');
    expect(extractInlineCommentFingerprint('<!-- mw-fp:!!! not base64 !!! -->')).toBe('');
  });

  it('excludes non-critical findings (warning)', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'warning' as const, title: 'Naming', description: 'Bad name', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('excludes non-critical findings (info)', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'info' as const, title: 'Tip', description: 'Consider this', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('excludes findings on files not in changed list', () => {
    const findings = [
      { file: 'src/other.ts', line: 5, severity: 'critical' as const, title: 'Bug', description: 'Oops', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('excludes findings with line=0', () => {
    const findings = [
      { file: 'src/app.ts', line: 0, severity: 'critical' as const, title: 'Bug', description: 'Oops', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('excludes findings with negative line numbers', () => {
    const findings = [
      { file: 'src/app.ts', line: -1, severity: 'critical' as const, title: 'Bug', description: 'Oops', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('handles multiple eligible findings', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'A', description: 'desc', suggestion: '' },
      { file: 'src/utils.ts', line: 20, severity: 'critical' as const, title: 'B', description: 'desc', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(2);
  });

  it('formats comment body with title and description', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'SQL Injection', description: 'Unsafe query', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result[0].body).toContain('SQL Injection');
    expect(result[0].body).toContain('Unsafe query');
  });

  it('includes suggestion in comment body when present', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Bug', description: 'Bad', suggestion: 'Fix it' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result[0].body).toContain('Suggestion');
    expect(result[0].body).toContain('Fix it');
  });

  it('omits suggestion section when suggestion is empty', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Bug', description: 'Bad', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result[0].body).not.toContain('Suggestion');
  });

  it('returns empty array for empty findings', () => {
    expect(buildInlineComments([], changedFiles)).toEqual([]);
  });

  it('prepends the INLINE_BOT_COMMENT_MARKER to every body so the inline-reply gate can distinguish MergeWatch threads from other bots', async () => {
    const { INLINE_BOT_COMMENT_MARKER } = await import('./client.js');
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Bug', description: 'desc', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result[0].body.startsWith(INLINE_BOT_COMMENT_MARKER)).toBe(true);
  });

  // ─── FP-L — verification-aware skipping ─────────────────────────────────
  it('FP-L: skips unverified critical findings — they render in the top-level body, not inline', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Maybe SQL', description: 'd', suggestion: '', verification: 'unverified' as const },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(0);
  });

  it('FP-L: keeps verified critical findings inline', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Confirmed SQL', description: 'd', suggestion: '', verification: 'verified' as const },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(1);
  });

  it('FP-L: keeps criticals with no verification field (pre-W2 back-compat)', () => {
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical' as const, title: 'Bug', description: 'd', suggestion: '' },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(1);
  });

  it('FP-L: in a mixed batch, drops only the unverified critical', () => {
    const findings = [
      { file: 'src/app.ts',   line: 10, severity: 'critical' as const, title: 'Verified',     description: 'd', suggestion: '', verification: 'verified' as const },
      { file: 'src/utils.ts', line: 20, severity: 'critical' as const, title: 'Unverified',   description: 'd', suggestion: '', verification: 'unverified' as const },
    ];
    const result = buildInlineComments(findings, changedFiles);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/app.ts');
  });
});

// ---------------------------------------------------------------------------
// extractInlineCommentTitle
// ---------------------------------------------------------------------------

describe('extractInlineCommentTitle', () => {
  it('extracts title from formatted inline comment', () => {
    const body = '**\u{1F534} SQL Injection**\n\nUser input used in query';
    expect(extractInlineCommentTitle(body)).toBe('SQL Injection');
  });

  it('returns empty string for unrelated text', () => {
    expect(extractInlineCommentTitle('just some random text')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractInlineCommentTitle('')).toBe('');
  });

  it('extracts title with special characters', () => {
    const body = '**\u{1F534} Use `parameterized` queries (SQL)**\n\nDescription here';
    expect(extractInlineCommentTitle(body)).toBe('Use `parameterized` queries (SQL)');
  });
});

// ---------------------------------------------------------------------------
// BOT_COMMENT_MARKER
// ---------------------------------------------------------------------------

describe('BOT_COMMENT_MARKER', () => {
  it('is an HTML comment', () => {
    expect(BOT_COMMENT_MARKER).toMatch(/^<!--[\s\S]*-->$/);
  });
});

// ---------------------------------------------------------------------------
// parseRepoConfigYaml
// ---------------------------------------------------------------------------

describe('parseRepoConfigYaml', () => {
  it('returns null for empty string', () => {
    expect(parseRepoConfigYaml('')).toBeNull();
  });

  it('returns null for non-object YAML', () => {
    expect(parseRepoConfigYaml('just a string')).toBeNull();
  });

  it('parses model field', () => {
    const result = parseRepoConfigYaml('model: my-model');
    expect(result?.model).toBe('my-model');
  });

  it('ignores invalid model type', () => {
    const result = parseRepoConfigYaml('model: 123');
    expect(result?.model).toBeUndefined();
  });

  it('parses a valid minConfidence (FP-A floor override)', () => {
    expect(parseRepoConfigYaml('minConfidence: 50')?.minConfidence).toBe(50);
    expect(parseRepoConfigYaml('minConfidence: 100')?.minConfidence).toBe(100);
    expect(parseRepoConfigYaml('minConfidence: 1')?.minConfidence).toBe(1);
  });

  it('ignores out-of-range or non-numeric minConfidence (keeps the default downstream)', () => {
    expect(parseRepoConfigYaml('minConfidence: 0')?.minConfidence).toBeUndefined();
    expect(parseRepoConfigYaml('minConfidence: 150')?.minConfidence).toBeUndefined();
    expect(parseRepoConfigYaml('minConfidence: -5')?.minConfidence).toBeUndefined();
    expect(parseRepoConfigYaml('minConfidence: "80"')?.minConfidence).toBeUndefined();
    expect(parseRepoConfigYaml('minConfidence: high')?.minConfidence).toBeUndefined();
  });

  it('parses a valid pricing override (#231)', () => {
    const yaml = `
pricing:
  gpt-4o:
    inputPer1M: 2.5
    outputPer1M: 10
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.pricing).toEqual({ 'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 } });
  });

  it('accepts 0/0 pricing (priced $0 for a local model) (#231)', () => {
    const yaml = `
pricing:
  llama3:
    inputPer1M: 0
    outputPer1M: 0
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.pricing).toEqual({ llama3: { inputPer1M: 0, outputPer1M: 0 } });
  });

  it('skips malformed pricing entries but keeps valid ones (#231)', () => {
    const yaml = `
pricing:
  good-model:
    inputPer1M: 1
    outputPer1M: 2
  missing-output:
    inputPer1M: 1
  negative:
    inputPer1M: -1
    outputPer1M: 2
  not-an-object: "nope"
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.pricing).toEqual({ 'good-model': { inputPer1M: 1, outputPer1M: 2 } });
  });

  it('leaves pricing undefined when all entries are invalid or it is an array (#231)', () => {
    expect(parseRepoConfigYaml('pricing:\n  bad:\n    inputPer1M: "x"\n    outputPer1M: 2')?.pricing).toBeUndefined();
    expect(parseRepoConfigYaml('pricing:\n  - foo')?.pricing).toBeUndefined();
  });

  it('skips prototype-pollution keys in pricing (#231)', () => {
    const yaml = `
pricing:
  __proto__:
    inputPer1M: 1
    outputPer1M: 2
  constructor:
    inputPer1M: 1
    outputPer1M: 2
  safe-model:
    inputPer1M: 3
    outputPer1M: 4
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.pricing).toEqual({ 'safe-model': { inputPer1M: 3, outputPer1M: 4 } });
    // The prototype is not polluted.
    expect(({} as Record<string, unknown>).inputPer1M).toBeUndefined();
  });

  it('parses agents as boolean object', () => {
    const yaml = `
agents:
  security: false
  bugs: true
  style: false
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agents?.security).toBe(false);
    expect(result?.agents?.bugs).toBe(true);
    expect(result?.agents?.style).toBe(false);
    expect(result?.agents?.summary).toBe(true); // default when not specified
  });

  it('ignores agents when it is an array (wrong format)', () => {
    const yaml = `
agents:
  - name: security
    enabled: true
`;
    const result = parseRepoConfigYaml(yaml);
    // Array-based agents format: parsed.agents is an array, typeof === 'object' is true
    // but the boolean checks will all fail, so all agents default to true
    expect(result?.agents?.security).toBe(true);
  });

  // ─── Rules parsing ───────────────────────────────────────────────────────
  it('parses rules with all fields', () => {
    const yaml = `
rules:
  maxFiles: 30
  ignorePatterns:
    - "*.lock"
    - "dist/**"
  autoReview: false
  reviewOnMention: true
  skipDrafts: false
  ignoreLabels:
    - wip
    - draft
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.rules).toBeDefined();
    expect(result!.rules!.maxFiles).toBe(30);
    expect(result!.rules!.ignorePatterns).toEqual(['*.lock', 'dist/**']);
    expect(result!.rules!.autoReview).toBe(false);
    expect(result!.rules!.reviewOnMention).toBe(true);
    expect(result!.rules!.skipDrafts).toBe(false);
    expect(result!.rules!.ignoreLabels).toEqual(['wip', 'draft']);
  });

  it('parses partial rules (only some fields)', () => {
    const yaml = `
rules:
  skipDrafts: false
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.rules).toBeDefined();
    expect(result!.rules!.skipDrafts).toBe(false);
    expect(result!.rules!.maxFiles).toBeUndefined();
    expect(result!.rules!.autoReview).toBeUndefined();
  });

  it('ignores invalid rule field types', () => {
    const yaml = `
rules:
  maxFiles: "not a number"
  skipDrafts: "yes"
  autoReview: 1
  ignorePatterns: "not-an-array"
  ignoreLabels:
    - valid-label
    - 123
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.rules).toBeDefined();
    expect(result!.rules!.maxFiles).toBeUndefined();
    expect(result!.rules!.skipDrafts).toBeUndefined();
    expect(result!.rules!.autoReview).toBeUndefined();
    expect(result!.rules!.ignorePatterns).toBeUndefined();
    // ignoreLabels filters non-strings
    expect(result!.rules!.ignoreLabels).toEqual(['valid-label']);
  });

  it('returns no rules when rules block is absent', () => {
    const result = parseRepoConfigYaml('model: my-model');
    expect(result?.rules).toBeUndefined();
  });

  // ─── includePatterns parsing ─────────────────────────────────────────────
  it('parses includePatterns as a string array', () => {
    const yaml = `
includePatterns:
  - "docs/runbooks/**"
  - "**/SECURITY.md"
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.includePatterns).toEqual(['docs/runbooks/**', '**/SECURITY.md']);
  });

  it('filters non-string entries from includePatterns', () => {
    const yaml = `
includePatterns:
  - "docs/**"
  - 42
  - null
  - "RUNBOOK.md"
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.includePatterns).toEqual(['docs/**', 'RUNBOOK.md']);
  });

  it('ignores includePatterns when not an array', () => {
    const result = parseRepoConfigYaml('includePatterns: "docs/**"');
    expect(result?.includePatterns).toBeUndefined();
  });

  it('returns no includePatterns when field is absent', () => {
    const result = parseRepoConfigYaml('model: my-model');
    expect(result?.includePatterns).toBeUndefined();
  });

  // ─── UX parsing ──────────────────────────────────────────────────────────
  it('parses ux config', () => {
    const yaml = `
ux:
  tone: direct
  showWorkDone: false
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.ux?.tone).toBe('direct');
    expect(result?.ux?.showWorkDone).toBe(false);
  });

  // ─── Custom agents ───────────────────────────────────────────────────────
  it('parses customAgents array', () => {
    const yaml = `
customAgents:
  - name: perf
    prompt: "Check for performance issues"
    severityDefault: warning
    enabled: true
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.customAgents).toHaveLength(1);
    expect(result!.customAgents![0].name).toBe('perf');
    expect(result!.customAgents![0].severityDefault).toBe('warning');
  });

  // ─── Agent review parsing ────────────────────────────────────────────────
  it('parses a full agentReview block', () => {
    const yaml = `
agentReview:
  enabled: true
  strictChecks: true
  autoIterate: false
  maxIterations: 5
  passThreshold: scoreAtLeast4
  detection:
    commitTrailers:
      - "Co-authored-by: Claude"
      - "Co-authored-by: Cursor"
    branchPrefixes:
      - "claude/"
      - "cursor/"
    labels:
      - ai-generated
      - bot
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agentReview).toBeDefined();
    expect(result!.agentReview!.enabled).toBe(true);
    expect(result!.agentReview!.strictChecks).toBe(true);
    expect(result!.agentReview!.autoIterate).toBe(false);
    expect(result!.agentReview!.maxIterations).toBe(5);
    expect(result!.agentReview!.passThreshold).toBe('scoreAtLeast4');
    expect(result!.agentReview!.detection!.commitTrailers).toEqual([
      'Co-authored-by: Claude',
      'Co-authored-by: Cursor',
    ]);
    expect(result!.agentReview!.detection!.branchPrefixes).toEqual(['claude/', 'cursor/']);
    expect(result!.agentReview!.detection!.labels).toEqual(['ai-generated', 'bot']);
  });

  it('leaves agentReview undefined when block is missing', () => {
    const result = parseRepoConfigYaml('model: foo');
    expect(result?.agentReview).toBeUndefined();
  });

  it('parses partial agentReview (only enabled)', () => {
    const yaml = `
agentReview:
  enabled: true
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agentReview).toBeDefined();
    expect(result!.agentReview!.enabled).toBe(true);
    expect(result!.agentReview!.strictChecks).toBeUndefined();
    expect(result!.agentReview!.autoIterate).toBeUndefined();
    expect(result!.agentReview!.maxIterations).toBeUndefined();
    expect(result!.agentReview!.passThreshold).toBeUndefined();
    expect(result!.agentReview!.detection).toBeUndefined();
  });

  it('omits invalid passThreshold while keeping other valid fields', () => {
    const yaml = `
agentReview:
  enabled: true
  passThreshold: bogus
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agentReview).toBeDefined();
    expect(result!.agentReview!.enabled).toBe(true);
    expect(result!.agentReview!.passThreshold).toBeUndefined();
  });

  it('omits invalid maxIterations (negative, zero, non-integer, >20)', () => {
    const cases = [
      'maxIterations: -1',
      'maxIterations: 0',
      'maxIterations: 2.5',
      'maxIterations: 21',
      'maxIterations: "3"',
    ];
    for (const line of cases) {
      const result = parseRepoConfigYaml(`agentReview:\n  enabled: true\n  ${line}\n`);
      expect(result?.agentReview).toBeDefined();
      expect(result!.agentReview!.enabled).toBe(true);
      expect(result!.agentReview!.maxIterations, line).toBeUndefined();
    }
  });

  it('filters non-string entries from detection.commitTrailers', () => {
    const yaml = `
agentReview:
  detection:
    commitTrailers:
      - "Co-authored-by: Claude"
      - 123
      - null
      - "Co-authored-by: Cursor"
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agentReview?.detection?.commitTrailers).toEqual([
      'Co-authored-by: Claude',
      'Co-authored-by: Cursor',
    ]);
  });

  it('leaves detection undefined when absent', () => {
    const yaml = `
agentReview:
  enabled: true
  maxIterations: 3
`;
    const result = parseRepoConfigYaml(yaml);
    expect(result?.agentReview).toBeDefined();
    expect(result!.agentReview!.detection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addPRReaction
// ---------------------------------------------------------------------------

describe('addPRReaction', () => {
  it('returns the reaction ID from a successful API call', async () => {
    const createForIssue = vi.fn().mockResolvedValue({ data: { id: 99 } });
    const octokit = { reactions: { createForIssue } } as unknown as Octokit;
    const id = await addPRReaction(octokit, 'o', 'r', 42, 'eyes');
    expect(id).toBe(99);
    expect(createForIssue).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      content: 'eyes',
    });
  });

  it('returns null and logs a warning when the API call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const createForIssue = vi.fn().mockRejectedValue(new Error('rate limit'));
    const octokit = { reactions: { createForIssue } } as unknown as Octokit;
    const id = await addPRReaction(octokit, 'o', 'r', 42, 'eyes');
    expect(id).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not throw on failure — reactions are non-critical', async () => {
    const createForIssue = vi.fn().mockRejectedValue(new Error('boom'));
    const octokit = { reactions: { createForIssue } } as unknown as Octokit;
    await expect(addPRReaction(octokit, 'o', 'r', 42, '+1')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removePRReaction
// ---------------------------------------------------------------------------

describe('removePRReaction', () => {
  it('deletes the reaction by ID via Octokit', async () => {
    const deleteForIssue = vi.fn().mockResolvedValue({});
    const octokit = { reactions: { deleteForIssue } } as unknown as Octokit;
    await removePRReaction(octokit, 'o', 'r', 42, 12345);
    expect(deleteForIssue).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      reaction_id: 12345,
    });
  });

  it('swallows API errors and logs a warning so finally blocks never re-throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteForIssue = vi.fn().mockRejectedValue(new Error('not found'));
    const octokit = { reactions: { deleteForIssue } } as unknown as Octokit;
    await expect(removePRReaction(octokit, 'o', 'r', 42, 12345)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// submitPRReview — W6 single-authoritative-comment body handling
// ---------------------------------------------------------------------------

describe('submitPRReview body handling (W6)', () => {
  // Mock just enough Octokit surface to capture the createReview payload.
  function captureCall() {
    const calls: Array<Record<string, unknown>> = [];
    const octokit = {
      pulls: { createReview: vi.fn(async (args: Record<string, unknown>) => { calls.push(args); return { data: {} }; }) },
    } as unknown as Octokit;
    return { octokit, calls };
  }

  it('APPROVE with empty body → body field omitted entirely', async () => {
    const { octokit, calls } = captureCall();
    await submitPRReview(octokit, 'o', 'r', 1, '', 'APPROVE');
    expect(calls).toHaveLength(1);
    expect('body' in calls[0]).toBe(false);
    expect(calls[0].event).toBe('APPROVE');
  });

  it('REQUEST_CHANGES with empty body → marker + one-line critical pointer (#356)', async () => {
    // The original HTML-comment-only stub rendered as an EMPTY review body
    // in the GitHub UI (HTML comments are stripped) — E2E-03's failure mode.
    const { octokit, calls } = captureCall();
    await submitPRReview(octokit, 'o', 'r', 1, '', 'REQUEST_CHANGES');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe(
      '<!-- mergewatch-review -->\n🔴 Critical issues found — see the full review in the summary comment above.',
    );
    expect(calls[0].event).toBe('REQUEST_CHANGES');
  });

  it('COMMENT with empty body → marker + one-line feedback pointer (#356)', async () => {
    const { octokit, calls } = captureCall();
    await submitPRReview(octokit, 'o', 'r', 1, '', 'COMMENT');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe(
      '<!-- mergewatch-review -->\n📝 Review feedback — see the full review in the summary comment above.',
    );
    expect(calls[0].event).toBe('COMMENT');
  });

  it('caller-supplied non-empty body is passed through unchanged (forward-compat)', async () => {
    const { octokit, calls } = captureCall();
    const body = 'A future tier may want this verbatim.';
    await submitPRReview(octokit, 'o', 'r', 1, body, 'COMMENT');
    expect(calls[0].body).toBe(body);
  });

  it('whitespace-only body is treated as empty for every event', async () => {
    const { octokit, calls } = captureCall();
    await submitPRReview(octokit, 'o', 'r', 1, '   \n\t  ', 'APPROVE');
    await submitPRReview(octokit, 'o', 'r', 1, '   ', 'REQUEST_CHANGES');
    expect('body' in calls[0]).toBe(false);
    expect(calls[1].body).toContain('Critical issues found');
  });

  it('passes inline comments through unchanged, batched in one API call', async () => {
    const { octokit, calls } = captureCall();
    const inline = [{ path: 'a.ts', line: 10, side: 'RIGHT', body: 'finding' }];
    await submitPRReview(octokit, 'o', 'r', 1, '', 'REQUEST_CHANGES', inline);
    expect(calls).toHaveLength(1); // single createReview call
    expect(calls[0].comments).toEqual(inline);
  });

  it('omits the `comments` field when no inline comments are passed', async () => {
    const { octokit, calls } = captureCall();
    await submitPRReview(octokit, 'o', 'r', 1, '', 'COMMENT');
    expect('comments' in calls[0]).toBe(false);
  });
});

describe('findExistingBotComment — stage scoping (#416)', () => {
  // With dev and prod both installed on one repo, each stage must find only
  // its own comment. Matching the other's would make the second reviewer try
  // to edit a comment it does not own, which GitHub rejects.
  function octokitWith(bodies: string[]) {
    return {
      paginate: {
        iterator: () => (async function* () {
          yield { data: bodies.map((body, i) => ({ id: 100 + i, body })) };
        })(),
      },
      issues: { listComments: {} },
    } as any;
  }

  it('prod ignores a dev comment', async () => {
    const octokit = octokitWith(['<!-- mergewatch-review:dev -->\nreview']);
    expect(await findExistingBotComment(octokit, 'o', 'r', 1)).toBeNull();
  });

  it('dev ignores a prod comment', async () => {
    const octokit = octokitWith(['<!-- mergewatch-review -->\nreview']);
    expect(await findExistingBotComment(octokit, 'o', 'r', 1, 'dev')).toBeNull();
  });

  it('each stage finds its own comment when both are present', async () => {
    const octokit = octokitWith([
      '<!-- mergewatch-review -->\nprod review',
      '<!-- mergewatch-review:dev -->\ndev review',
    ]);
    expect(await findExistingBotComment(octokit, 'o', 'r', 1)).toBe(100);
    expect(await findExistingBotComment(octokit, 'o', 'r', 1, 'dev')).toBe(101);
  });

  it('an absent stage still finds the legacy prod comment', async () => {
    // Back-compat: every comment written before #416 carries the bare marker.
    const octokit = octokitWith(['<!-- mergewatch-review -->\nold review']);
    expect(await findExistingBotComment(octokit, 'o', 'r', 1)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// #418 — dismissStaleReviews must only ever dismiss OUR OWN App's reviews
// ---------------------------------------------------------------------------

describe('dismissStaleReviews — only our own reviews (#418)', () => {
  function octokitWith(reviews: Array<{ id: number; login: string; state?: string }>) {
    const dismissed: number[] = [];
    const octokit = {
      pulls: {
        listReviews: async () => ({
          data: reviews.map((r) => ({
            id: r.id,
            state: r.state ?? 'APPROVED',
            user: { login: r.login, type: 'Bot' },
          })),
        }),
        dismissReview: async ({ review_id }: { review_id: number }) => {
          dismissed.push(review_id);
          return {};
        },
      },
    } as any;
    return { octokit, dismissed };
  }

  it('dismisses our own stale review', async () => {
    const { octokit, dismissed } = octokitWith([{ id: 1, login: 'mergewatch' }]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([1]);
  });

  it('leaves the OTHER stage\'s review alone', async () => {
    // The collision that surfaced this: dev and prod both installed on one
    // repo, whichever ran second dismissed the other's review.
    const { octokit, dismissed } = octokitWith([
      { id: 1, login: 'mergewatch-ai-dev' },
      { id: 2, login: 'mergewatch' },
    ]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([2]);
  });

  it('leaves another vendor\'s bot alone', async () => {
    // The pre-existing, customer-facing half: MergeWatch was dismissing
    // CopilotAI / dependabot / CodeQL reviews on every re-review.
    const { octokit, dismissed } = octokitWith([
      { id: 1, login: 'copilot-pull-request-reviewer' },
      { id: 2, login: 'dependabot' },
      { id: 3, login: 'github-advanced-security' },
      { id: 4, login: 'mergewatch' },
    ]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([4]);
  });

  it('leaves a human review alone', async () => {
    const { octokit, dismissed } = octokitWith([{ id: 1, login: 'santthosh' }]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([]);
  });

  it('skips reviews already dismissed', async () => {
    const { octokit, dismissed } = octokitWith([
      { id: 1, login: 'mergewatch', state: 'DISMISSED' },
      { id: 2, login: 'mergewatch', state: 'CHANGES_REQUESTED' },
    ]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([2]);
  });

  it('normalizes the [bot] suffix in either direction', async () => {
    // REST and GraphQL disagree about the suffix; matching raw strings would
    // silently fail to recognise our own review.
    const { octokit, dismissed } = octokitWith([{ id: 1, login: 'mergewatch[bot]' }]);
    await dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch');
    expect(dismissed).toEqual([1]);

    const b = octokitWith([{ id: 2, login: 'mergewatch' }]);
    await dismissStaleReviews(b.octokit, 'o', 'r', 1, 'MergeWatch[bot]');
    expect(b.dismissed).toEqual([2]);
  });

  it('dismisses NOTHING when our identity is unknown', async () => {
    // Fail-safe direction: leaving our own review stale is cosmetic, dismissing
    // a stranger's is not. Also asserts we do not even list reviews.
    for (const login of [undefined, null, '']) {
      const { octokit, dismissed } = octokitWith([
        { id: 1, login: 'mergewatch' },
        { id: 2, login: 'dependabot' },
      ]);
      await dismissStaleReviews(octokit, 'o', 'r', 1, login as any);
      expect(dismissed).toEqual([]);
    }
  });

  it('survives a dismissReview failure without throwing', async () => {
    const octokit = {
      pulls: {
        listReviews: async () => ({ data: [{ id: 1, state: 'APPROVED', user: { login: 'mergewatch' } }] }),
        dismissReview: async () => { throw new Error('403'); },
      },
    } as any;
    await expect(dismissStaleReviews(octokit, 'o', 'r', 1, 'mergewatch')).resolves.toBeUndefined();
  });
});

describe('resolveAppLogin (#418)', () => {
  beforeEach(() => __resetAppLoginCache());

  it('reads our login from a comment we authored', async () => {
    const octokit = {
      issues: { getComment: async () => ({ data: { user: { login: 'mergewatch' } } }) },
    } as any;
    expect(await resolveAppLogin(octokit, 'o', 'r', 42)).toBe('mergewatch');
  });

  it('caches per key so the lookup costs one call per process', async () => {
    let calls = 0;
    const octokit = {
      issues: {
        getComment: async () => { calls++; return { data: { user: { login: 'mergewatch' } } }; },
      },
    } as any;
    await resolveAppLogin(octokit, 'o', 'r', 1, 'k');
    await resolveAppLogin(octokit, 'o', 'r', 2, 'k');
    expect(calls).toBe(1);
  });

  it('keeps stages separate under different cache keys', async () => {
    const make = (login: string) => ({
      issues: { getComment: async () => ({ data: { user: { login } } }) },
    }) as any;
    expect(await resolveAppLogin(make('mergewatch'), 'o', 'r', 1, 'prod')).toBe('mergewatch');
    expect(await resolveAppLogin(make('mergewatch-ai-dev'), 'o', 'r', 1, 'dev')).toBe('mergewatch-ai-dev');
  });

  it('returns null when the comment cannot be read', async () => {
    const octokit = { issues: { getComment: async () => { throw new Error('404'); } } } as any;
    expect(await resolveAppLogin(octokit, 'o', 'r', 1)).toBeNull();
  });

  it('returns null when the comment has no author', async () => {
    const octokit = { issues: { getComment: async () => ({ data: {} }) } } as any;
    expect(await resolveAppLogin(octokit, 'o', 'r', 1)).toBeNull();
  });
});
