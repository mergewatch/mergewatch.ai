/**
 * Default configuration values for MergeWatch reviews.
 * These are used when no .mergewatch.yml is found in the repository
 * or when specific fields are omitted from the config.
 */

/** Definition of a user-defined custom review agent. */
export interface CustomAgentDef {
  /** Display name for the agent (used as finding category) */
  name: string;
  /** System prompt for the agent */
  prompt: string;
  /** Default severity for findings from this agent */
  severityDefault: 'info' | 'warning' | 'critical';
  /** Whether this custom agent is enabled */
  enabled: boolean;
}

export interface UXConfig {
  /** Tone of review findings: collaborative (default), direct, or advisory */
  tone: 'collaborative' | 'direct' | 'advisory';
  /** Whether to show the "work done" section in the review comment */
  showWorkDone: boolean;
  /** Whether to show how many findings were suppressed by the orchestrator */
  showSuppressedCount: boolean;
  /** Whether to show a reviewer checklist derived from top findings */
  reviewerChecklist: boolean;
  /** Whether to show a special "all clear" message when there are no findings */
  allClearMessage: boolean;
  /** Custom header text for the review comment (replaces default logo) */
  commentHeader: string;
}

export const DEFAULT_UX_CONFIG: UXConfig = {
  tone: 'collaborative',
  showWorkDone: true,
  showSuppressedCount: true,
  reviewerChecklist: true,
  allClearMessage: true,
  commentHeader: '',
};

export interface RulesConfig {
  /** Maximum number of changed files before skipping review */
  maxFiles: number;
  /**
   * @deprecated Use top-level `excludePatterns` instead. When set on a user
   *   YAML, mergeConfig appends entries here into `excludePatterns` and emits
   *   a one-time deprecation warning. The field remains in the type only so
   *   existing `.mergewatch.yml` files continue to parse without errors.
   */
  ignorePatterns: string[];
  /** Whether to automatically review PRs on open/synchronize */
  autoReview: boolean;
  /** Whether to run review when mentioned in a PR comment */
  reviewOnMention: boolean;
  /** Whether to skip draft pull requests */
  skipDrafts: boolean;
  /** GitHub labels that cause a PR to be skipped */
  ignoreLabels: string[];
}

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  maxFiles: 50,
  // Empty by default — file-pattern exclusions live on top-level
  // excludePatterns (the canonical field). Kept on the type for back-compat
  // with older .mergewatch.yml files; mergeConfig folds any user-provided
  // entries here into excludePatterns at parse time.
  ignorePatterns: [],
  autoReview: true,
  reviewOnMention: true,
  skipDrafts: true,
  ignoreLabels: ['skip-review'],
};

/** Valid values for agentReview.passThreshold. */
export const PASS_THRESHOLDS = ['noCritical', 'noFindings', 'scoreAtLeast4', 'scoreAtLeast5'] as const;

export type PassThreshold = (typeof PASS_THRESHOLDS)[number];

export interface AgentReviewDetectionConfig {
  /** Commit trailer substrings that identify agent-authored commits */
  commitTrailers: string[];
  /** Branch name prefixes that identify agent-authored PRs */
  branchPrefixes: string[];
  /** Labels that mark a PR as agent-authored */
  labels: string[];
}

export interface AgentReviewConfig {
  /** Master switch for agent-authored PR handling */
  enabled: boolean;
  /** Inject agent-mode prompt suffix when source='agent' */
  strictChecks: boolean;
  /** Gate iteration tracking + reviewer whisper */
  autoIterate: boolean;
  /** Cap re-reviews per PR for iteration metadata (1..20) */
  maxIterations: number;
  /** Threshold required for an agent-authored PR to pass */
  passThreshold: PassThreshold;
  /** Heuristics for detecting agent-authored PRs */
  detection: AgentReviewDetectionConfig;
}

export const DEFAULT_AGENT_REVIEW_CONFIG: AgentReviewConfig = {
  enabled: true,
  strictChecks: true,
  autoIterate: true,
  maxIterations: 3,
  passThreshold: 'noCritical',
  detection: {
    commitTrailers: ['Co-authored-by: Claude'],
    branchPrefixes: ['claude/'],
    labels: ['ai-generated'],
  },
};

export interface MergeWatchConfig {
  /** Primary model used for review agents */
  model: string;
  /** Lightweight model used for summary/orchestration when cost matters */
  lightModel: string;
  /** Maximum tokens for each agent response */
  maxTokensPerAgent: number;
  /** Which review agents to enable */
  agents: {
    security: boolean;
    bugs: boolean;
    style: boolean;
    summary: boolean;
    diagram: boolean;
    errorHandling: boolean;
    testCoverage: boolean;
    commentAccuracy: boolean;
  };
  /** Custom style rules appended to the style agent prompt */
  customStyleRules: string[];
  /**
   * Path to a markdown file documenting repo conventions. Injected into every
   * agent prompt so MergeWatch respects repo-specific patterns over generic
   * best practices (e.g. "errors handled via middleware, don't flag missing
   * try/catch"). When unset, auto-discovery looks for AGENTS.md, CONVENTIONS.md,
   * and .mergewatch/conventions.md at the repo root in that order.
   */
  conventions?: string;
  /** File patterns to exclude from review (glob syntax) */
  excludePatterns: string[];
  /**
   * File patterns that override the internal SKIP_PATTERNS list, forcing
   * MergeWatch to review the PR even when it would otherwise be skipped
   * as "trivial." Use this to opt docs-only PRs (or any other normally
   * skipped category) back into review for specific paths — for example,
   * a critical-docs subdirectory or a top-level SECURITY markdown file.
   *
   * Operates at the PR-skip layer, NOT the diff-filter layer. It does
   * not modify what's sent to the agents on a PR that's already being
   * reviewed — that's `excludePatterns`. It only decides whether the
   * PR gets reviewed at all when every file is otherwise trivial.
   */
  includePatterns: string[];
  /** Minimum severity to report: 'info' | 'warning' | 'critical' */
  minSeverity: 'info' | 'warning' | 'critical';
  /** Maximum number of findings to include in the comment */
  maxFindings: number;
  /** Whether to post a summary even when there are no findings */
  postSummaryOnClean: boolean;
  /** Whether to fetch related file contents for context-aware reviews */
  codebaseAwareness: boolean;
  /** Maximum rounds of agentic file requests per agent (1-2) */
  maxFileRequestRounds: number;
  /** Maximum total size of related file context in KB */
  maxContextKB: number;
  /** User-defined custom review agents */
  customAgents: CustomAgentDef[];
  /** UX configuration for reviewer experience */
  ux: UXConfig;
  /** Rules controlling when and what gets reviewed */
  rules: RulesConfig;
  /** Custom pricing overrides (model ID → USD per 1M tokens) for cost estimation */
  pricing?: Record<string, { inputPer1M: number; outputPer1M: number }>;
  /** Agent-authored PR detection + strict-mode review settings */
  agentReview?: AgentReviewConfig;
}

export const DEFAULT_CONFIG: MergeWatchConfig = {
  model: 'us.anthropic.claude-opus-4-6-v1',
  lightModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  maxTokensPerAgent: 4096,
  agents: {
    security: true,
    bugs: true,
    style: true,
    summary: true,
    diagram: true,
    errorHandling: true,
    testCoverage: true,
    commentAccuracy: true,
  },
  customStyleRules: [],
  excludePatterns: [
    '**/*.lock',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/*.min.js',
    '**/*.min.css',
    '**/dist/**',
    '**/build/**',
    '**/node_modules/**',
  ],
  includePatterns: [],
  minSeverity: 'info',
  maxFindings: 25,
  postSummaryOnClean: true,
  codebaseAwareness: true,
  maxFileRequestRounds: 1,
  maxContextKB: 256,
  customAgents: [],
  ux: { ...DEFAULT_UX_CONFIG },
  rules: { ...DEFAULT_RULES_CONFIG },
};

/**
 * Merges a partial user config (from .mergewatch.yml / DynamoDB) with defaults.
 * Only defined fields in the partial override the defaults.
 */
export function mergeConfig(
  partial: Partial<Omit<MergeWatchConfig, 'agents' | 'ux' | 'rules' | 'agentReview'>> & {
    agents?: Partial<MergeWatchConfig['agents']>;
    ux?: Partial<UXConfig>;
    rules?: Partial<RulesConfig>;
    agentReview?: Partial<Omit<AgentReviewConfig, 'detection'>> & {
      detection?: Partial<AgentReviewDetectionConfig>;
    };
  },
): MergeWatchConfig {
  const { agentReview, ...rest } = partial;
  const merged: MergeWatchConfig = {
    ...DEFAULT_CONFIG,
    ...rest,
    agents: {
      ...DEFAULT_CONFIG.agents,
      ...(rest.agents ?? {}),
    },
    customAgents: rest.customAgents ?? DEFAULT_CONFIG.customAgents,
    pricing: rest.pricing ?? DEFAULT_CONFIG.pricing,
    ux: {
      ...DEFAULT_UX_CONFIG,
      ...(rest.ux ?? {}),
    },
    rules: {
      ...DEFAULT_RULES_CONFIG,
      ...(rest.rules ?? {}),
    },
  };

  // Soft-deprecation: fold rules.ignorePatterns into top-level excludePatterns
  // so existing .mergewatch.yml files keep working. After this merge the
  // ignorePatterns array is cleared — call sites should read excludePatterns
  // exclusively.
  const userIgnorePatterns = rest.rules?.ignorePatterns;
  if (Array.isArray(userIgnorePatterns) && userIgnorePatterns.length > 0) {
    console.warn(
      '[mergewatch] rules.ignorePatterns is deprecated; move these entries to top-level excludePatterns. Auto-merging for now.',
    );
    merged.excludePatterns = [...merged.excludePatterns, ...userIgnorePatterns];
    merged.rules.ignorePatterns = [];
  }
  if (agentReview !== undefined) {
    const a = agentReview;
    const d = a.detection ?? {};
    merged.agentReview = {
      enabled: a.enabled ?? DEFAULT_AGENT_REVIEW_CONFIG.enabled,
      strictChecks: a.strictChecks ?? DEFAULT_AGENT_REVIEW_CONFIG.strictChecks,
      autoIterate: a.autoIterate ?? DEFAULT_AGENT_REVIEW_CONFIG.autoIterate,
      maxIterations: a.maxIterations ?? DEFAULT_AGENT_REVIEW_CONFIG.maxIterations,
      passThreshold: a.passThreshold ?? DEFAULT_AGENT_REVIEW_CONFIG.passThreshold,
      detection: {
        commitTrailers: d.commitTrailers ?? DEFAULT_AGENT_REVIEW_CONFIG.detection.commitTrailers,
        branchPrefixes: d.branchPrefixes ?? DEFAULT_AGENT_REVIEW_CONFIG.detection.branchPrefixes,
        labels: d.labels ?? DEFAULT_AGENT_REVIEW_CONFIG.detection.labels,
      },
    };
  }
  return merged;
}
