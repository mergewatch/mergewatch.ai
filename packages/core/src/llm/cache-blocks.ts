import type { PromptInput, PromptSegment, PromptStability } from './prompt-segment.js';
import { renderPrompt } from './prompt-segment.js';

/**
 * #490 — turn segments into Anthropic content blocks with `cache_control` at
 * stability boundaries.
 *
 * Lives in core because both Bedrock and Anthropic need identical behaviour,
 * but it emits only the shape; neither the decision to cache nor the wire call
 * belongs here. A provider without a cache API ignores this entirely and keeps
 * calling `renderPrompt`.
 */

/** Anthropic allows at most 4 cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Group consecutive segments by stability, then mark the END of each group as
 * a cache breakpoint.
 *
 * Why group rather than mark every segment: a breakpoint mid-way through a run
 * of equally-stable text buys nothing and spends one of the four. Why the END
 * of a group: `cache_control` marks a prefix boundary — everything up to and
 * including that block is the cached prefix.
 *
 * The LAST group is never marked. Caching a prefix that includes the most
 * volatile segment would write a cache entry nothing can ever read, paying the
 * 1.25x write premium for no read.
 */
export function toCacheableBlocks(prompt: PromptInput): AnthropicContentBlock[] {
  if (typeof prompt === 'string') return [{ type: 'text', text: prompt }];
  const segments = prompt as readonly PromptSegment[];
  if (segments.length === 0) return [{ type: 'text', text: '' }];

  // Collapse consecutive same-stability segments into one block.
  const groups: Array<{ stability: PromptStability; text: string }> = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (last && last.stability === seg.stability) last.text += seg.text;
    else groups.push({ stability: seg.stability, text: seg.text });
  }

  // Breakpoints go on the earliest boundaries: the most stable prefixes are
  // the ones most worth caching, and they are also the ones most likely to be
  // shared with another request.
  const markable = Math.max(0, groups.length - 1);
  const marks = Math.min(markable, MAX_CACHE_BREAKPOINTS);

  return groups.map((g, i) => (
    i < marks
      ? { type: 'text' as const, text: g.text, cache_control: { type: 'ephemeral' as const } }
      : { type: 'text' as const, text: g.text }
  ));
}

/** True when this prompt has any boundary worth marking. */
export function hasCacheableBoundary(prompt: PromptInput): boolean {
  return typeof prompt !== 'string'
    && new Set((prompt as readonly PromptSegment[]).map((s) => s.stability)).size > 1;
}

/** Rendered text, for providers with no cache API. */
export { renderPrompt };
