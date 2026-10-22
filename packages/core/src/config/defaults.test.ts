import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_RULES_CONFIG,
  DEFAULT_AGENT_REVIEW_CONFIG,
  mergeConfig,
} from './defaults.js';
import { DEFAULT_INSTALLATION_SETTINGS } from '../types/db.js';

describe('DEFAULT_CONFIG', () => {
  it('has all agent flags as booleans', () => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG.agents)) {
      expect(typeof value, `agents.${key}`).toBe('boolean');
    }
  });

  it('model is a non-empty string', () => {
    expect(DEFAULT_CONFIG.model).toBeTypeOf('string');
    expect(DEFAULT_CONFIG.model.length).toBeGreaterThan(0);
  });

  it('#706 — approving is off by default, in the yml config and the dashboard settings', () => {
    expect(DEFAULT_CONFIG.approve).toBe(false);
    expect(DEFAULT_INSTALLATION_SETTINGS.approve).toBe(false);
  });
});

describe('mergeConfig', () => {
  it('empty partial returns object equal to DEFAULT_CONFIG values', () => {
    const result = mergeConfig({});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('overrides model while keeping other defaults', () => {
    const result = mergeConfig({ model: 'custom-model' });
    expect(result.model).toBe('custom-model');
    expect(result.agents).toEqual(DEFAULT_CONFIG.agents);
    expect(result.maxFindings).toBe(DEFAULT_CONFIG.maxFindings);
  });

  it('deep merges agents: security false, others unchanged', () => {
    const result = mergeConfig({ agents: { security: false } });
    expect(result.agents.security).toBe(false);
    expect(result.agents.bugs).toBe(DEFAULT_CONFIG.agents.bugs);
    expect(result.agents.style).toBe(DEFAULT_CONFIG.agents.style);
    expect(result.agents.summary).toBe(DEFAULT_CONFIG.agents.summary);
    expect(result.agents.diagram).toBe(DEFAULT_CONFIG.agents.diagram);
  });

  it('deep merges ux', () => {
    const result = mergeConfig({ ux: { tone: 'direct' } });
    expect(result.ux.tone).toBe('direct');
    expect(result.ux.showWorkDone).toBe(DEFAULT_CONFIG.ux.showWorkDone);
    expect(result.ux.reviewerChecklist).toBe(DEFAULT_CONFIG.ux.reviewerChecklist);
  });

  it('customAgents replaces array (not merge)', () => {
    const custom = [
      { name: 'my-agent', prompt: 'do stuff', severityDefault: 'info' as const, enabled: true },
    ];
    const result = mergeConfig({ customAgents: custom });
    expect(result.customAgents).toEqual(custom);
    expect(result.customAgents).not.toBe(DEFAULT_CONFIG.customAgents);
  });

  it('overrides maxFindings scalar', () => {
    const result = mergeConfig({ maxFindings: 10 });
    expect(result.maxFindings).toBe(10);
  });

  it('returned object is new reference (not DEFAULT_CONFIG)', () => {
    const result = mergeConfig({});
    expect(result).not.toBe(DEFAULT_CONFIG);
  });

  it('mergeConfig with pricing sets pricing field', () => {
    const pricing = { 'my-model': { inputPer1M: 1, outputPer1M: 2 } };
    const result = mergeConfig({ pricing });
    expect(result.pricing).toEqual(pricing);
  });

  it('empty partial returns default rules', () => {
    const result = mergeConfig({});
    expect(result.rules).toEqual(DEFAULT_RULES_CONFIG);
  });

  it('deep merges partial rules with defaults', () => {
    const result = mergeConfig({ rules: { skipDrafts: false } });
    expect(result.rules.skipDrafts).toBe(false);
    expect(result.rules.maxFiles).toBe(DEFAULT_RULES_CONFIG.maxFiles);
    expect(result.rules.autoReview).toBe(DEFAULT_RULES_CONFIG.autoReview);
    expect(result.rules.ignoreLabels).toEqual(DEFAULT_RULES_CONFIG.ignoreLabels);
  });

  it('overrides rules.maxFiles while keeping other rule defaults', () => {
    const result = mergeConfig({ rules: { maxFiles: 100 } });
    expect(result.rules.maxFiles).toBe(100);
    expect(result.rules.skipDrafts).toBe(DEFAULT_RULES_CONFIG.skipDrafts);
  });

  it('overrides rules.ignoreLabels array', () => {
    const result = mergeConfig({ rules: { ignoreLabels: ['wip', 'draft'] } });
    expect(result.rules.ignoreLabels).toEqual(['wip', 'draft']);
  });

  it('folds deprecated rules.ignorePatterns into top-level excludePatterns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeConfig({ rules: { ignorePatterns: ['*.generated.ts'] } });
    // The deprecated field is cleared on the merged config…
    expect(result.rules.ignorePatterns).toEqual([]);
    // …and its entries appended to the canonical excludePatterns list.
    expect(result.excludePatterns).toContain('*.generated.ts');
    // Defaults still preserved.
    expect(result.rules.maxFiles).toBe(DEFAULT_RULES_CONFIG.maxFiles);
    // One-time deprecation warning emitted.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rules.ignorePatterns is deprecated'),
    );
    warn.mockRestore();
  });

  it('does not warn when rules.ignorePatterns is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeConfig({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves agentReview undefined when partial omits it', () => {
    const result = mergeConfig({});
    expect(result.agentReview).toBeUndefined();
  });

  it('deep-merges partial agentReview with DEFAULT_AGENT_REVIEW_CONFIG', () => {
    const result = mergeConfig({
      agentReview: {
        enabled: false,
        maxIterations: 7,
        detection: { labels: ['bot-pr'] },
      },
    });
    expect(result.agentReview).toBeDefined();
    expect(result.agentReview!.enabled).toBe(false);
    expect(result.agentReview!.maxIterations).toBe(7);
    expect(result.agentReview!.strictChecks).toBe(DEFAULT_AGENT_REVIEW_CONFIG.strictChecks);
    expect(result.agentReview!.autoIterate).toBe(DEFAULT_AGENT_REVIEW_CONFIG.autoIterate);
    expect(result.agentReview!.passThreshold).toBe(DEFAULT_AGENT_REVIEW_CONFIG.passThreshold);
    expect(result.agentReview!.detection.labels).toEqual(['bot-pr']);
    expect(result.agentReview!.detection.commitTrailers).toEqual(
      DEFAULT_AGENT_REVIEW_CONFIG.detection.commitTrailers,
    );
    expect(result.agentReview!.detection.branchPrefixes).toEqual(
      DEFAULT_AGENT_REVIEW_CONFIG.detection.branchPrefixes,
    );
  });
});
