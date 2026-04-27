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
});
