// Item 7 — mechanical schema-freeze gate for `ContextEngine` (§VII roster).
//
// Reads the source of `context-engine.ts`, extracts the body of the
// `ContextEngine` interface, and asserts the method names are exactly the three
// contract methods: `compact`, `shouldCompact`, `onTurnComplete`.
//
// The same list is mirrored in ARCHITECTURE.md's machine-readable
// `frozen_schemas.context_engine` block (`frozen_method_count` +
// `frozen_methods`), and this gate cross-checks it — so a PR that adds a verb
// without bumping the manifest in the same commit fails on BOTH halves.
// Mirrors `memory-method-count.test.ts`, which does the same for
// `MemoryProvider`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = join(import.meta.dirname, '..', 'context-engine.ts');
const ARCHITECTURE = join(import.meta.dirname, '..', '..', '..', '..', 'ARCHITECTURE.md');

const FROZEN_METHODS = ['compact', 'shouldCompact', 'onTurnComplete'];

/**
 * Extract the body of `interface ContextEngine { ... }` and return the
 * top-level method names. Brace-depth scan so nested generics / object types in
 * parameter or return positions don't pollute the list. Optional methods carry
 * a `?` between the name and the parameter list, so the lookahead skips one.
 */
function extractContextEngineMethods(src: string): string[] {
  const startMarker = 'export interface ContextEngine {';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('ContextEngine interface not found');
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

/** The `context_engine:` entry from ARCHITECTURE.md's `frozen_schemas:` block. */
function readArchitectureManifest(md: string): { count: number; methods: string[] } {
  const entryIdx = md.indexOf('\n  context_engine:');
  if (entryIdx < 0) throw new Error('frozen_schemas.context_engine not found in ARCHITECTURE.md');
  const block = md.slice(entryIdx, entryIdx + 500);
  const count = /frozen_method_count:\s*(\d+)/.exec(block)?.[1];
  const methods = /frozen_methods:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (count === undefined || methods === undefined) {
    throw new Error('context_engine entry is missing frozen_method_count / frozen_methods');
  }
  return {
    count: Number(count),
    methods: methods
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

describe('ContextEngine method-count gate', () => {
  it('exposes exactly the three contract methods', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    expect(extractContextEngineMethods(src)).toEqual(FROZEN_METHODS);
  });

  it('matches the ARCHITECTURE.md §VII frozen_schemas manifest', () => {
    const manifest = readArchitectureManifest(readFileSync(ARCHITECTURE, 'utf-8'));
    expect(manifest.methods).toEqual(FROZEN_METHODS);
    expect(manifest.count).toBe(FROZEN_METHODS.length);
  });
});
