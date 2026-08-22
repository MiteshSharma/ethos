// D14 (a2a-spec-compat phase) — mechanical schema-freeze gate for the A2A
// signed `AgentCard`. See ARCHITECTURE.md §VII's roster row and
// docs/content/building/explanation/agent-card-governance.md for why: a peer
// verifies this card once, out of band, and anchors trust on the field shape
// staying put. `packages/types/src/a2a.ts` was NOT modified by this
// amendment — it adds governance around the existing shape, not a new field.
//
// Reads the source of `a2a.ts`, counts top-level properties on the
// `AgentCard` interface AND their names, and asserts both match
// `.agent-card-field-count` / this file's declared name list. A PR that
// adds, removes, or renames a field without updating both fails this test —
// mirrors `personality-field-count.test.ts`'s field-count approach, plus a
// name check so a rename (same count, different field) is also caught.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE = join(import.meta.dirname, '..', 'a2a.ts');
const COUNT_FILE = join(REPO_ROOT, '.agent-card-field-count');

/** Top-level field names on `AgentCard`, in declaration order. */
function fieldNames(src: string): string[] {
  const startMarker = 'export interface AgentCard';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('AgentCard interface not found');
  const openIdx = src.indexOf('{', startIdx);
  if (openIdx < 0) throw new Error('AgentCard opening brace not found');

  const names: string[] = [];
  let depth = 0;
  let started = false;
  let i = openIdx;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      started = true;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (started && depth === 0) break;
    }
  }
  const body = src.slice(openIdx + 1, i);

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/**')) {
      continue;
    }
    const m = line.match(/^([A-Za-z_$][\w]*)\??\s*:/);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

const EXPECTED_FIELDS = [
  'id',
  'name',
  'description',
  'protocolVersion',
  'skills',
  'endpoints',
  'publicKey',
  'keyFingerprint',
  'signatureAlg',
  'signature',
  'did',
];

describe('D14: AgentCard schema freeze (ARCHITECTURE.md §VII)', () => {
  it('field count matches .agent-card-field-count (bump the file in lockstep with schema changes)', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const declared = Number.parseInt(readFileSync(COUNT_FILE, 'utf-8').trim(), 10);
    const actual = fieldNames(src).length;

    expect(
      actual,
      `AgentCard has ${actual} fields; .agent-card-field-count says ${declared}. Bump the file per the AgentCard §VII bump procedure in ARCHITECTURE.md.`,
    ).toBe(declared);
  });

  it('field NAMES match exactly — a same-count rename fails this test too', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    expect(fieldNames(src)).toEqual(EXPECTED_FIELDS);
  });
});
