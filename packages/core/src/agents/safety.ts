/**
 * #712 — the safety score: area matching, the blast-radius cap, the weighted
 * score and the clamp to the matched area's band. Pure functions only; the
 * agent call that produces the ratings is `runSafetyAgent` in reviewer.ts.
 *
 * Nothing here feeds the merge gate, and gate.ts must not import this module:
 * the safety score is advisory.
 */
import { Minimatch } from 'minimatch';
import {
  SAFETY_FACTORS,
  type SafetyArea,
  type SafetyFactor,
  type SafetyLevel,
  type SafetyScoreConfig,
} from '../config/defaults.js';

type Bands = SafetyScoreConfig['bands'];

/** safe 0, caution 1, risky 2. */
const RISK_RANK: Record<SafetyLevel, number> = { safe: 0, caution: 1, risky: 2 };

/** A configured area that at least one changed file matched. */
export interface SafetyAreaMatch {
  name?: string;
  level?: SafetyLevel;
  notes?: string;
  matchedPatterns: string[];
  files: string[];
}

export interface SafetyFactorResult {
  /** The rating used in the score, after the blast-radius cap. 1-5, 5 safest. */
  rating: number;
  label: SafetyLevel;
  note: string;
  /** The model's rating, when the cap lowered it. */
  cappedFrom?: number;
  /** #713 — the label `cappedFrom` would have had, for the comment. */
  cappedFromLabel?: SafetyLevel;
}

export interface SafetyResult {
  score: number;
  /** The weighted score before the clamp to the matched area's band. */
  uncappedScore: number;
  /** The area whose level clamped the score, when the clamp changed it. */
  clampedBy?: string;
  band: SafetyLevel;
  /** #713 — the configured emoji for `band`, so the comment needs no config. */
  emoji: string;
  /** #719 — render the factor detail collapsed. Absent reads as expanded. */
  collapsed?: boolean;
  /** #717 — new top-level folders no area covers. Advisory; never scored. */
  uncoveredFolders?: string[];
  factors: Record<SafetyFactor, SafetyFactorResult>;
  concerns: string[];
  matchedAreas: SafetyAreaMatch[];
  /** Names of pattern-less areas the model said applied. */
  appliedAreas: string[];
  /** The global notes the model said applied. */
  appliedNotes: string[];
}

/** The band a 1-100 score falls in. Each bound is inclusive. */
export function bandFor(score: number, bands: Bands): SafetyLevel {
  return score <= bands.risky ? 'risky' : score <= bands.caution ? 'caution' : 'safe';
}

/** The band of a single 1-5 rating, mapped onto the same 1-100 scale. */
export function labelFor(rating: number, bands: Bands): SafetyLevel {
  return bandFor(1 + Math.round((99 * (rating - 1)) / 4), bands);
}

/**
 * The highest blast-radius rating an area of `level` allows: the largest
 * rating whose label is at least as risky as `level`. Rating 1 always
 * qualifies, so the cap is never below 1.
 */
export function capRating(level: SafetyLevel, bands: Bands): number {
  let cap = 1;
  for (let r = 1; r <= 5; r++) {
    if (RISK_RANK[labelFor(r, bands)] >= RISK_RANK[level]) cap = r;
  }
  return cap;
}

/** How a matched area is named in the result, when it has no name. */
export function areaLabel(area: Pick<SafetyArea, 'name' | 'patterns'>): string {
  return area.name ?? (area.patterns ?? []).join(', ');
}

/** How a matched area is named: its name, or its first matched pattern. */
export function matchLabel(m: Pick<SafetyAreaMatch, 'name' | 'matchedPatterns'>): string {
  return m.name ?? m.matchedPatterns[0];
}

/**
 * Tests every changed file against every area that has patterns. Each pattern
 * is compiled once: calling `minimatch()` per file costs seconds at the config
 * caps. `dot: true` so `services/**` covers `services/x/.env`.
 *
 * Not matched: files dropped by excludePatterns / maxFileDiffKB (they are not
 * in the diff), and a pure rename out of an area, which the diff keys only by
 * its new path.
 */
export function matchAreas(areas: SafetyArea[], files: string[]): SafetyAreaMatch[] {
  const matches: SafetyAreaMatch[] = [];
  for (const area of areas) {
    if (!area.patterns?.length) continue;
    const compiled = area.patterns.map((p) => ({ p, m: new Minimatch(p, { dot: true }) }));
    const matchedPatterns = new Set<string>();
    const matchedFiles: string[] = [];
    for (const file of files) {
      const hits = compiled.filter(({ m }) => m.match(file));
      if (hits.length === 0) continue;
      matchedFiles.push(file);
      for (const { p } of hits) matchedPatterns.add(p);
    }
    if (matchedFiles.length === 0) continue;
    matches.push({
      ...(area.name !== undefined ? { name: area.name } : {}),
      ...(area.level !== undefined ? { level: area.level } : {}),
      ...(area.notes !== undefined ? { notes: area.notes } : {}),
      matchedPatterns: [...matchedPatterns],
      files: matchedFiles,
    });
  }
  return matches;
}

/** The first matched area with the riskiest level, or undefined when none has a level. */
function riskiestMatch(matches: SafetyAreaMatch[]): SafetyAreaMatch | undefined {
  let worst: SafetyAreaMatch | undefined;
  for (const m of matches) {
    if (m.level === undefined) continue;
    if (!worst || RISK_RANK[m.level] > RISK_RANK[worst.level!]) worst = m;
  }
  return worst;
}

/**
 * Turns the model's 1-5 ratings into the score.
 *
 *   w     = 1 + round(99 · Σ wᵢ(rᵢ − 1) / (4 · Σ wᵢ))      (all 5s → 100, all 1s → 1)
 *   score = min(w, ceiling(riskiest matched level))
 *
 * The riskiest matched level caps the blast-radius rating AND clamps the
 * score to that level's band, so a clean change in a risky area still reads
 * risky. A level never raises a score.
 */
export function computeSafetyScore(
  ratings: Record<SafetyFactor, { rating: number; note?: string }>,
  config: Pick<SafetyScoreConfig, 'bands' | 'factors'>,
  matches: SafetyAreaMatch[],
): Pick<SafetyResult, 'score' | 'uncappedScore' | 'clampedBy' | 'band' | 'factors'> {
  const { bands } = config;
  const worst = riskiestMatch(matches);
  const factors = {} as Record<SafetyFactor, SafetyFactorResult>;
  let weighted = 0;
  let totalWeight = 0;
  for (const f of SAFETY_FACTORS) {
    const model = ratings[f].rating;
    const cap = f === 'blastRadius' && worst?.level ? capRating(worst.level, bands) : 5;
    const rating = Math.min(model, cap);
    factors[f] = {
      rating,
      label: labelFor(rating, bands),
      note: ratings[f].note ?? '',
      ...(rating < model ? { cappedFrom: model, cappedFromLabel: labelFor(model, bands) } : {}),
    };
    const weight = config.factors[f].weight;
    weighted += weight * (rating - 1);
    totalWeight += weight;
  }
  const uncappedScore = 1 + Math.round((99 * weighted) / (4 * totalWeight));
  const ceiling = worst?.level === 'risky' ? bands.risky : worst?.level === 'caution' ? bands.caution : 100;
  const score = Math.min(uncappedScore, ceiling);
  return {
    score,
    uncappedScore,
    ...(score < uncappedScore && worst ? { clampedBy: matchLabel(worst) } : {}),
    band: bandFor(score, bands),
    factors,
  };
}

const MAX_CONCERNS = 2;
const MAX_TEXT = 300;

/** Collapses newlines and cuts to 300 characters. */
const clean = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, MAX_TEXT);

/**
 * Validates the safety agent's JSON and builds the result. Throws when any of
 * the five ratings is missing or not an integer from 1 to 5: there is no
 * partial result.
 */
export function buildSafetyResult(
  parsed: unknown,
  config: SafetyScoreConfig,
  matches: SafetyAreaMatch[],
): SafetyResult {
  const obj = (parsed ?? {}) as {
    ratings?: Record<string, { rating?: unknown; note?: unknown } | undefined>;
    concerns?: unknown;
    appliedAreas?: unknown;
    appliedNotes?: unknown;
  };
  const ratings = {} as Record<SafetyFactor, { rating: number; note: string }>;
  for (const f of SAFETY_FACTORS) {
    const r = obj.ratings?.[f];
    if (!r || !Number.isInteger(r.rating) || (r.rating as number) < 1 || (r.rating as number) > 5) {
      throw new Error(`invalid rating for ${f}: ${JSON.stringify(r?.rating)}`);
    }
    ratings[f] = { rating: r.rating as number, note: typeof r.note === 'string' ? clean(r.note) : '' };
  }

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const concerns = strings(obj.concerns).map(clean).filter(Boolean).slice(0, MAX_CONCERNS);

  // Only pattern-less areas can be "applied" by the model; a patterned area
  // applies by matching, in code.
  const patternless = new Map(
    config.areas.filter((a) => !a.patterns?.length && a.name).map((a) => [a.name!.toLowerCase(), a.name!]),
  );
  const appliedAreas = [...new Set(strings(obj.appliedAreas)
    .map((n) => patternless.get(n.toLowerCase()))
    .filter((n): n is string => n !== undefined))];

  const appliedNotes = [...new Set(Array.isArray(obj.appliedNotes) ? obj.appliedNotes : [])]
    .filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < config.notes.length)
    .map((i) => config.notes[i]);

  const scored = computeSafetyScore(ratings, config, matches);
  return {
    ...scored,
    emoji: config.emoji[scored.band],
    ...(config.collapsed ? { collapsed: true } : {}),
    concerns,
    matchedAreas: matches,
    appliedAreas,
    appliedNotes,
  };
}

const FACTOR_TITLES: Record<SafetyFactor, string> = {
  blastRadius: 'Blast radius',
  changeSize: 'Change size',
  testing: 'Testing',
  errorMonitoring: 'Error monitoring',
  rollback: 'Rollback',
};

/**
 * The repo-derived half of the safety prompt: the changed files, the matched
 * areas, the pattern-less areas, the numbered global notes and the factor
 * notes. Repo text is joined by concatenation only — never through
 * `String.prototype.replace`, which would expand `$&` / `$'` in it (S-18).
 */
export function buildSafetyGuidance(
  config: SafetyScoreConfig,
  matches: SafetyAreaMatch[],
  stats: { files: string[]; additions: number; deletions: number },
): string {
  const lines: string[] = ['--- Safety guidance for this repository ---', ''];
  lines.push(`Changed files (${stats.files.length} files, +${stats.additions}/−${stats.deletions}):`);
  for (const f of stats.files) lines.push(`- ${f}`);

  if (matches.length > 0) {
    lines.push('', 'Areas this change touches (matched by file pattern):');
    for (const m of matches) {
      const level = m.level ? ` [${m.level}]` : '';
      const notes = m.notes ? ` — ${m.notes}` : '';
      lines.push(`- ${areaLabel({ name: m.name, patterns: m.matchedPatterns })}${level}${notes} (files: ${m.files.join(', ')})`);
    }
  }

  const patternless = config.areas.filter((a) => !a.patterns?.length);
  if (patternless.length > 0) {
    lines.push('', 'Areas with no file pattern — decide from the diff whether each applies, and list the ones that do in appliedAreas:');
    for (const a of patternless) {
      const level = a.level ? ` [${a.level}]` : '';
      lines.push(`- ${a.name}${level}${a.notes ? ` — ${a.notes}` : ''}`);
    }
  }

  if (config.notes.length > 0) {
    lines.push('', 'Repository notes — list the index of each one that applies in appliedNotes:');
    config.notes.forEach((n, i) => lines.push(`[${i}] ${n}`));
  }

  const factorNotes = SAFETY_FACTORS.filter((f) => config.factors[f].notes);
  if (factorNotes.length > 0) {
    lines.push('', 'Notes on individual factors:');
    for (const f of factorNotes) lines.push(`- ${FACTOR_TITLES[f]}: ${config.factors[f].notes}`);
  }
  return lines.join('\n');
}
