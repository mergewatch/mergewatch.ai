/**
 * #390 — JSON Schemas for schema-constrained agent output.
 *
 * These make explicit what the prompts' "Response format" blocks have always
 * described in prose. When a provider supports `invokeStructured`, the model
 * is FORCED to emit an object matching one of these — the #382 class of
 * "could not parse agent JSON response" finding loss cannot occur on that
 * path. Kept deliberately permissive (no additionalProperties: false, minimal
 * `required`) so a model adding a harmless extra field never fails a strict
 * validator; downstream code already tolerates missing optionals.
 */

const FINDING_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Repo-relative path of the file the finding is in' },
    line: { type: 'integer', description: 'Line number the finding anchors to (a changed line)' },
    severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
    confidence: { type: 'integer', minimum: 1, maximum: 100 },
    title: { type: 'string' },
    description: { type: 'string' },
    suggestion: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['file', 'line', 'severity', 'title'],
} as const;

/**
 * Findings agents (built-in + custom). `requestFiles` folds the agentic
 * file-fetch protocol into the SAME schema: instead of the text-mode
 * convention of replying with a bare `{"requestFiles": [...]}` object —
 * whose ambiguity caused #382 mode A — the model fills an explicit field.
 * A non-empty `requestFiles` means "fetch these and re-invoke me"; the
 * fetcher's existing round/budget logic handles it unchanged.
 */
export const AGENT_FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING_ITEM_SCHEMA },
    requestFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Repo-relative file paths to fetch for more context before finalizing findings. Leave empty (or omit) to finalize now.',
    },
  },
  required: ['findings'],
} as const;

/** Orchestrator: deduplicated findings + merge verdict. */
export const ORCHESTRATOR_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING_ITEM_SCHEMA },
    mergeScore: { type: 'integer', minimum: 1, maximum: 5 },
    mergeScoreReason: { type: 'string' },
  },
  required: ['findings', 'mergeScore', 'mergeScoreReason'],
} as const;

/** W2 / FP-E verifier verdict for a single finding. */
export const VERIFIER_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    valid: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'One sentence citing the specific code' },
  },
  required: ['valid', 'reason'],
} as const;
