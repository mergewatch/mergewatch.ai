/**
 * W3 — triage-aware convergence guard.
 *
 * The author replies to a review with a `## mergewatch triage` comment that
 * rebuts or defers specific findings. Without this, the next review re-raises
 * the rebutted finding under a drifted title/line (the whack-a-mole's second
 * half, paired with W9's stable identity key).
 *
 * This module: (1) detects triage comments on a PR, (2) maps the free-text
 * triage prose onto the prior review's findings via one light-model call, and
 * (3) yields the set of finding identity keys whose author disposition is
 * "don't re-raise" (rebutted / deferred). reviewer.ts suppresses current
 * findings whose key intersects that set.
 *
 * Fail-safe direction: every error path returns an EMPTY suppression set.
 * Infra trouble must never *hide* a finding — only an explicit, parseable
 * author disposition suppresses one. (Mirror of the W2 verification stance,
 * pointed the safe way.)
 */

import { Octokit } from '@octokit/rest';
import type { ILLMProvider } from './llm/types.js';
import { normalizeLLMResult } from './llm/types.js';
import { findingMatchKeys, type FindingLike } from './review-delta.js';
import { TRIAGE_MAPPING_PROMPT } from './agents/prompts.js';

/** Heading the author convention uses to open a triage reply. */
export const TRIAGE_MARKER = '## mergewatch triage';

/** Dispositions that mean "the author handled this — do not re-raise it". */
const SUPPRESSING_DISPOSITIONS = new Set(['rebutted', 'deferred']);

export interface TriagePriorFinding extends FindingLike {
  severity?: string;
}

/**
 * A comment is a triage reply if its body — ignoring leading blockquote/
 * whitespace noise — starts with the triage marker (case-insensitive).
 */
export function isTriageComment(body: string | null | undefined): boolean {
  if (!body) return false;
  return body
    .replace(/^[\s>]+/, '')
    .toLowerCase()
    .startsWith(TRIAGE_MARKER.toLowerCase());
}

/**
 * Fetch every triage comment body on a PR (oldest → newest). Best-effort:
 * a listing failure returns [] (suppress nothing).
 */
export async function fetchTriageComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  try {
    const out: string[] = [];
    const iterator = octokit.paginate.iterator(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    for await (const { data: comments } of iterator) {
      for (const c of comments) {
        if (isTriageComment(c.body)) out.push(c.body as string);
      }
    }
    return out;
  } catch (err) {
    console.warn('[triage] failed to list PR comments — suppressing nothing:', err);
    return [];
  }
}

/** Minimal, defensive JSON-array extraction from a model response. */
function parseDispositionArray(
  raw: string,
): Array<{ index: number; disposition: string }> {
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  if (!s.startsWith('[')) {
    const m = s.match(/\[[\s\S]*\]/);
    if (m) s = m[0];
  }
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Map the author's triage prose onto prior-finding identity keys to suppress.
 * One light-model call. Returns [] on no triage / no priors / any failure.
 */
export async function computeDisputedKeys(
  triageComments: string[],
  priorFindings: TriagePriorFinding[],
  llm: ILLMProvider,
  modelId: string,
): Promise<string[]> {
  if (triageComments.length === 0 || priorFindings.length === 0) return [];

  const list = priorFindings
    .map((f, i) => `[${i}] (${f.severity ?? '?'}) ${f.file}:${f.line} — ${f.title}`)
    .join('\n');
  const prompt = `${TRIAGE_MAPPING_PROMPT}

--- Prior review findings ---
${list}

--- Author triage replies ---
${triageComments.join('\n\n----\n\n')}`;

  try {
    const raw = normalizeLLMResult(
      await llm.invoke(modelId, prompt, undefined, { temperature: 0 }),
    ).text;
    const items = parseDispositionArray(raw);
    const keys = new Set<string>();
    for (const item of items) {
      const f = priorFindings[item?.index];
      if (!f) continue;
      if (SUPPRESSING_DISPOSITIONS.has(String(item.disposition).toLowerCase())) {
        for (const k of findingMatchKeys(f)) keys.add(k);
        console.warn(
          '[triage] author %s "%s" (%s:%d) — will suppress on re-review',
          item.disposition,
          f.title,
          f.file,
          f.line,
        );
      }
    }
    return [...keys];
  } catch (err) {
    console.warn('[triage] mapping call failed — suppressing nothing:', err);
    return [];
  }
}

/**
 * Partition findings into those kept and those suppressed because the author
 * already dispositioned them in a triage reply (key intersects disputedKeys).
 */
export function partitionDisputed<T extends FindingLike>(
  findings: T[],
  disputedKeys: string[] | undefined,
): { kept: T[]; suppressed: T[] } {
  if (!disputedKeys || disputedKeys.length === 0) return { kept: findings, suppressed: [] };
  const disputed = new Set(disputedKeys);
  const kept: T[] = [];
  const suppressed: T[] = [];
  for (const f of findings) {
    if (findingMatchKeys(f).some((k) => disputed.has(k))) suppressed.push(f);
    else kept.push(f);
  }
  return { kept, suppressed };
}
