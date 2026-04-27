// Phase 30.9 — surface code must throw `EthosError`, not raw `Error`.
//
// Library code (packages/*, extensions/*) may still `throw new Error(...)`.
// Surface code is anything user-rendered: CLI commands and the wiring entry.
// `EthosError` carries `{ code, cause, action }` so the top-level handler can
// render a useful message; `throw new Error('boom')` defeats that.
//
// This test fails on a deliberate `throw new Error('...')` in any of the
// scanned files. Add new surface files to SCAN_GLOBS as they ship.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SURFACE_DIRS = [
  // CLI commands — every user-facing command path
  join(import.meta.dirname, '..', 'commands'),
];

const RAW_THROW = /\bthrow\s+new\s+Error\s*\(/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...walkTs(full));
    } else if (extname(entry) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('Phase 30.9: surface code throws EthosError, not raw Error', () => {
  it('has no `throw new Error(...)` under apps/ethos/src/commands', () => {
    const offenders: string[] = [];
    for (const dir of SURFACE_DIRS) {
      for (const file of walkTs(dir)) {
        const src = readFileSync(file, 'utf-8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (RAW_THROW.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Surface code must throw \`new EthosError({ code, cause, action })\` instead of raw \`Error\`. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
