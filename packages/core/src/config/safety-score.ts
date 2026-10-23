/**
 * #711 — per-field validation of a `.mergewatch.yml` `safetyScore:` block.
 *
 * Each bad field is dropped and its reason recorded, starting with the field's
 * path. Any error disables the feature for the review (see `mergeConfig`,
 * which adds the cross-field rules: `risky < caution`, not every weight 0).
 * The caps bound the prompt the safety agent (#712) builds from this block.
 */
import {
  SAFETY_FACTORS,
  SAFETY_LEVELS,
  type SafetyArea,
  type SafetyFactor,
  type SafetyLevel,
  type SafetyScoreInput,
} from './defaults.js';

const MAX_AREAS = 50;
const MAX_PATTERNS = 20;
const MAX_PATTERN_LEN = 200;
const MAX_NAME_LEN = 80;
const MAX_NOTE_LEN = 500;
const MAX_TOP_NOTES = 20;
const MAX_EMOJI_LEN = 16;
const MAX_WEIGHT = 1000;

const TOP_KEYS = ['enabled', 'bands', 'emoji', 'factors', 'areas', 'notes'];
const BAND_KEYS = ['risky', 'caution'] as const;
const FACTOR_KEYS = ['weight', 'notes'];
const AREA_KEYS = ['name', 'patterns', 'level', 'notes'];

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNote = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NOTE_LEN;

/** Records an error for every key of `obj` not in `allowed`. */
function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown key`);
  }
}

function parseArea(raw: unknown, path: string, errors: string[]): SafetyArea | undefined {
  if (!isMapping(raw)) { errors.push(`${path}: must be a mapping`); return undefined; }
  rejectUnknown(raw, AREA_KEYS, path, errors);
  const area: SafetyArea = {};
  const before = errors.length;

  if (raw.patterns !== undefined) {
    const p = raw.patterns;
    if (!Array.isArray(p) || p.length < 1 || p.length > MAX_PATTERNS
      || !p.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_PATTERN_LEN)) {
      errors.push(`${path}.patterns: must be 1-${MAX_PATTERNS} non-empty strings of at most ${MAX_PATTERN_LEN} characters`);
    } else {
      area.patterns = p as string[];
    }
  }
  if (raw.level !== undefined) {
    if (!SAFETY_LEVELS.includes(raw.level as SafetyLevel)) {
      errors.push(`${path}.level: must be one of ${SAFETY_LEVELS.join(', ')}`);
    } else {
      area.level = raw.level as SafetyLevel;
    }
  }
  if (raw.notes !== undefined) {
    if (!isNote(raw.notes)) errors.push(`${path}.notes: must be a string of at most ${MAX_NOTE_LEN} characters`);
    else area.notes = raw.notes;
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > MAX_NAME_LEN) {
      errors.push(`${path}.name: must be a non-empty string of at most ${MAX_NAME_LEN} characters`);
    } else {
      area.name = raw.name;
    }
  }
  if (raw.patterns === undefined && raw.notes === undefined) {
    errors.push(`${path}: needs patterns or notes`);
  } else if (raw.patterns === undefined && raw.name === undefined) {
    errors.push(`${path}.name: required when there are no patterns`);
  }
  return errors.length === before ? area : undefined;
}

/**
 * Parses a raw `safetyScore:` value. Returns what survived validation plus
 * every error; the caller records the errors as `safetyScoreErrors`.
 */
export function parseSafetyScoreBlock(raw: unknown): { value: SafetyScoreInput; errors: string[] } {
  const errors: string[] = [];
  const value: SafetyScoreInput = {};
  if (!isMapping(raw)) return { value, errors: ['safetyScore: must be a mapping'] };
  rejectUnknown(raw, TOP_KEYS, 'safetyScore', errors);

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') errors.push('safetyScore.enabled: must be true or false');
    else value.enabled = raw.enabled;
  }

  if (raw.bands !== undefined) {
    if (!isMapping(raw.bands)) {
      errors.push('safetyScore.bands: must be a mapping');
    } else {
      rejectUnknown(raw.bands, BAND_KEYS, 'safetyScore.bands', errors);
      const bands: SafetyScoreInput['bands'] = {};
      for (const k of BAND_KEYS) {
        const v = raw.bands[k];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 99) {
          errors.push(`safetyScore.bands.${k}: must be an integer from 1 to 99`);
        } else {
          bands[k] = v as number;
        }
      }
      value.bands = bands;
    }
  }

  if (raw.emoji !== undefined) {
    if (!isMapping(raw.emoji)) {
      errors.push('safetyScore.emoji: must be a mapping');
    } else {
      rejectUnknown(raw.emoji, SAFETY_LEVELS, 'safetyScore.emoji', errors);
      const emoji: SafetyScoreInput['emoji'] = {};
      for (const k of SAFETY_LEVELS) {
        const v = raw.emoji[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length === 0 || v.length > MAX_EMOJI_LEN || /[\r\n]/.test(v)) {
          errors.push(`safetyScore.emoji.${k}: must be a non-empty single-line string of at most ${MAX_EMOJI_LEN} characters`);
        } else {
          emoji[k] = v;
        }
      }
      value.emoji = emoji;
    }
  }

  if (raw.factors !== undefined) {
    if (!isMapping(raw.factors)) {
      errors.push('safetyScore.factors: must be a mapping');
    } else {
      const factors: NonNullable<SafetyScoreInput['factors']> = {};
      for (const [name, f] of Object.entries(raw.factors)) {
        const path = `safetyScore.factors.${name}`;
        if (!SAFETY_FACTORS.includes(name as SafetyFactor)) { errors.push(`${path}: unknown factor`); continue; }
        if (!isMapping(f)) { errors.push(`${path}: must be a mapping`); continue; }
        rejectUnknown(f, FACTOR_KEYS, path, errors);
        const out: { weight?: number; notes?: string } = {};
        if (f.weight !== undefined) {
          // Finite and bounded: an Infinity or NaN weight would make the score NaN.
          if (typeof f.weight !== 'number' || !Number.isFinite(f.weight) || f.weight < 0 || f.weight > MAX_WEIGHT) {
            errors.push(`${path}.weight: must be a number from 0 to ${MAX_WEIGHT}`);
          } else {
            out.weight = f.weight;
          }
        }
        if (f.notes !== undefined) {
          if (!isNote(f.notes)) errors.push(`${path}.notes: must be a string of at most ${MAX_NOTE_LEN} characters`);
          else out.notes = f.notes;
        }
        factors[name as SafetyFactor] = out;
      }
      value.factors = factors;
    }
  }

  if (raw.areas !== undefined) {
    if (!Array.isArray(raw.areas)) {
      errors.push('safetyScore.areas: must be a list');
    } else if (raw.areas.length > MAX_AREAS) {
      errors.push(`safetyScore.areas: at most ${MAX_AREAS} areas`);
    } else {
      const areas: SafetyArea[] = [];
      const seen = new Set<string>();
      raw.areas.forEach((a, i) => {
        const area = parseArea(a, `safetyScore.areas[${i}]`, errors);
        if (!area) return;
        if (area.name !== undefined) {
          const key = area.name.toLowerCase();
          if (seen.has(key)) { errors.push(`safetyScore.areas[${i}].name: duplicate area name "${area.name}"`); return; }
          seen.add(key);
        }
        areas.push(area);
      });
      value.areas = areas;
    }
  }

  if (raw.notes !== undefined) {
    if (!Array.isArray(raw.notes) || raw.notes.length > MAX_TOP_NOTES || !raw.notes.every(isNote)) {
      errors.push(`safetyScore.notes: must be at most ${MAX_TOP_NOTES} strings of at most ${MAX_NOTE_LEN} characters`);
    } else {
      value.notes = raw.notes as string[];
    }
  }

  return { value, errors };
}
