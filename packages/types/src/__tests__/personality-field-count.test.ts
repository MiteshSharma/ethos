// Phase 30.8 — mechanical schema-freeze gate for `PersonalityConfig`.
//
// Reads the source of `personality.ts`, counts top-level properties on the
// `PersonalityConfig` interface, and asserts the count matches the integer
// in `.personality-field-count` at the repo root. A PR that adds a field
// without bumping the file fails this test — and the GitHub Action that
// reviews PRs touching `.personality-field-count` requires the
// `personality-schema-change` label + two-maintainer approval.
//
// Culture (header comment in personality.ts, CONTRIBUTING.md) sets the
// rule. This file is the enforcement.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE = join(import.meta.dirname, '..', 'personality.ts');
const COUNT_FILE = join(REPO_ROOT, '.personality-field-count');

/**
 * Extract the body of `interface PersonalityConfig { ... }` and count the
 * top-level property names. We use a brace-depth scan rather than a regex
 * so that nested object types (e.g. `Record<string, unknown>`) do not
 * inflate the count.
 */
function countFields(src: string): number {
  const startMarker = 'export interface PersonalityConfig';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('PersonalityConfig interface not found');
  const openIdx = src.indexOf('{', startIdx);
  if (openIdx < 0) throw new Error('PersonalityConfig opening brace not found');

  let depth = 1;
  let i = openIdx + 1;
  let body = '';
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
    i++;
  }

  // Strip block + line comments so commented-out fields don't count.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Top-level properties live at brace-depth 0 within the body. Walk
  // character-by-character, track depth, and count `name?: type;` /
  // `name: type;` lines that begin a property at depth 0.
  let d = 0;
  let count = 0;
  let atFieldStart = true;
  for (let j = 0; j < stripped.length; j++) {
    const ch = stripped[j];
    if (ch === '{' || ch === '<' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') d--;
    else if (ch === ';' && d === 0) {
      atFieldStart = true;
    } else if (d === 0 && atFieldStart && /[A-Za-z_$]/.test(ch ?? '')) {
      count++;
      atFieldStart = false;
    } else if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
      // whitespace — leave atFieldStart alone
    } else if (d === 0 && atFieldStart) {
      atFieldStart = false;
    }
  }

  return count;
}

/** Top-level field names on `PersonalityConfig`, in declaration order. */
function fieldNames(src: string): string[] {
  const startIdx = src.indexOf('export interface PersonalityConfig');
  if (startIdx < 0) throw new Error('PersonalityConfig interface not found');
  const body = src.slice(src.indexOf('{', startIdx) + 1);
  const names: string[] = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (depth === 0 && trimmed === '}') break;
    if (depth === 0) {
      const m = trimmed.match(/^([A-Za-z_$][\w]*)\??\s*:/);
      if (m?.[1]) names.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return names;
}

describe('Phase 30.8: PersonalityConfig schema freeze', () => {
  it('field count matches .personality-field-count (bump the file in lockstep with schema changes)', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const declared = Number.parseInt(readFileSync(COUNT_FILE, 'utf-8').trim(), 10);
    const actual = countFields(src);

    expect(
      actual,
      `PersonalityConfig has ${actual} fields; .personality-field-count says ${declared}. Bump the file (and follow the personality-schema-change PR rules in packages/types/src/personality.ts header).`,
    ).toBe(declared);
  });

  // The voice V1a amendment (eng-review D2) granted EXACTLY ONE field in the
  // otherwise-forbidden speech/audio category: `voice`, carrying identity —
  // which voice this personality speaks in. The amendment is not a licence for
  // voice modes, VAD tuning, or per-channel speech affordances, so the
  // narrowness is pinned mechanically rather than left to review memory.
  it('grants exactly one speech/audio field — `voice` — per the V1a amendment', () => {
    const names = fieldNames(readFileSync(SOURCE, 'utf-8'));
    const speechFields = names.filter((n) => /voice|speech|audio|tts|stt|spoken/i.test(n));
    expect(
      speechFields,
      'Only `voice` is sanctioned. Voice modes, VAD tuning, and per-channel speech ' +
        'affordances belong in ~/.ethos/config.yaml or adapter config — see the ' +
        '"Common rejections" note in packages/types/src/personality.ts.',
    ).toEqual(['voice']);
  });
});
