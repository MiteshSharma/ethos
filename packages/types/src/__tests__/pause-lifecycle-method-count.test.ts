// Mechanical schema-freeze gate for `PauseLifecycle` (§VII roster).
//
// Reads the source of `pause-lifecycle.ts`, extracts the body of the
// `PauseLifecycle` interface, and asserts the method names are exactly the two
// contract methods: `readPauseOffset`, `signalReadyToSuspend`. The brace-depth
// scan is why the supporting `PauseOffset` interface in the same file does not
// pollute the list.
//
// The same list is mirrored in ARCHITECTURE.md's machine-readable
// `frozen_schemas.pause_lifecycle` block (`frozen_method_count` +
// `frozen_methods`), and this gate cross-checks it — so a PR that adds a
// method without bumping the manifest in the same commit fails on BOTH
// halves. Mirrors `content-store-method-count.test.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoopPauseLifecycle } from '../pause-lifecycle';

const SOURCE = join(import.meta.dirname, '..', 'pause-lifecycle.ts');
const ARCHITECTURE = join(import.meta.dirname, '..', '..', '..', '..', 'ARCHITECTURE.md');

const FROZEN_METHODS = ['readPauseOffset', 'signalReadyToSuspend'];

/**
 * Extract the body of `interface PauseLifecycle { ... }` and return the
 * top-level method names. Brace-depth scan so nested generics / object types in
 * parameter or return positions don't pollute the list. Optional methods carry
 * a `?` between the name and the parameter list, so the lookahead skips one.
 */
function extractPauseLifecycleMethods(src: string): string[] {
  const startMarker = 'export interface PauseLifecycle {';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('PauseLifecycle interface not found');
  const openIdx = src.indexOf('{', startIdx);

  let depth = 1;
  let i = openIdx + 1;
  let body = '';
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{' || ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
    i++;
  }

  // Strip block + line comments so commented-out methods don't count.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const methods: string[] = [];
  let d = 0;
  let cursor = 0;
  while (cursor < stripped.length) {
    const ch = stripped[cursor];
    if (ch === '(' || ch === '{' || ch === '<' || ch === '[') {
      d++;
      cursor++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === '>' || ch === ']') {
      d--;
      cursor++;
      continue;
    }
    if (d === 0 && ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let end = cursor;
      while (end < stripped.length) {
        const c = stripped[end];
        if (c === undefined || !/[A-Za-z0-9_$]/.test(c)) break;
        end++;
      }
      const name = stripped.slice(cursor, end);
      // Skip whitespace, then one optional-marker `?`, then whitespace again.
      let look = end;
      while (look < stripped.length && /\s/.test(stripped[look] ?? '')) look++;
      if (stripped[look] === '?') {
        look++;
        while (look < stripped.length && /\s/.test(stripped[look] ?? '')) look++;
      }
      if (stripped[look] === '(') methods.push(name);
      cursor = end;
      continue;
    }
    cursor++;
  }
  return methods;
}

/** The `pause_lifecycle:` entry from ARCHITECTURE.md's `frozen_schemas:` block. */
function readArchitectureManifest(md: string): { count: number; methods: string[] } {
  const entryIdx = md.indexOf('\n  pause_lifecycle:');
  if (entryIdx < 0) throw new Error('frozen_schemas.pause_lifecycle not found in ARCHITECTURE.md');
  const block = md.slice(entryIdx, entryIdx + 500);
  const count = /frozen_method_count:\s*(\d+)/.exec(block)?.[1];
  const methods = /frozen_methods:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (count === undefined || methods === undefined) {
    throw new Error('pause_lifecycle entry is missing frozen_method_count / frozen_methods');
  }
  return {
    count: Number(count),
    methods: methods
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

describe('PauseLifecycle method-count gate', () => {
  it('exposes exactly the two contract methods', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    expect(extractPauseLifecycleMethods(src)).toEqual(FROZEN_METHODS);
  });

  it('matches the ARCHITECTURE.md §VII frozen_schemas manifest', () => {
    const manifest = readArchitectureManifest(readFileSync(ARCHITECTURE, 'utf-8'));
    expect(manifest.methods).toEqual(FROZEN_METHODS);
    expect(manifest.count).toBe(FROZEN_METHODS.length);
  });
});

describe('NoopPauseLifecycle', () => {
  it('reports no pause offset', async () => {
    await expect(new NoopPauseLifecycle().readPauseOffset()).resolves.toBeNull();
  });

  it('signals ready-to-suspend without throwing', async () => {
    await expect(new NoopPauseLifecycle().signalReadyToSuspend()).resolves.toBeUndefined();
  });
});
