// Source hygiene — no literal NUL (0x00) bytes in source files.
//
// WHY THIS IS BANNED
//
// ripgrep classifies any file containing a 0x00 byte as BINARY. In a recursive
// search it does not warn, it does not print "binary file matches" — it SKIPS
// the file silently and reports zero hits. Every `rg` in this repo therefore
// went blind to such a file, for every developer and every agent. The failure
// mode is the worst kind: a search that returns nothing looks exactly like a
// symbol that genuinely has no callers, so it produces confidently wrong
// conclusions ("no production caller — safe to delete") instead of an error.
//
// This is a SOURCE-ENCODING rule, not a semantic one. A NUL is a perfectly good
// sentinel or composite-key separator precisely because it cannot appear in a
// user-supplied name, so the VALUE is fine — only its spelling in the file is
// the problem.
//
// WHAT TO WRITE INSTEAD
//
//   const KEY = '\x00default';              // yes — escape sequence
//   const KEY = '<a literal 0x00 byte>';    // no  — rg skips this whole file
//
// `'\x00'` (and `'\0'`) compile to the identical single U+0000 code unit, in
// both quoted strings and template literals. There is no runtime difference —
// only `rg` can tell them apart, and that is the entire point.
//
// SCOPE
//
// `packages/`, `apps/` and `extensions/` — everything a developer greps. Build
// output (`dist/`, `dist-electron/`), `node_modules/` and hidden directories are
// skipped, and only text-source extensions are read, so genuine binary fixtures
// (audio, images, `.asar`) are never candidates.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const SCAN_DIRS = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'extensions')];

// Generated or vendored trees — not hand-written source, not what anyone greps.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  'out',
  'release',
  '.next',
]);

// Text sources only. Anything not listed here may legitimately be binary.
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.css',
  '.scss',
  '.html',
  '.txt',
  '.sh',
]);

/**
 * Modules that deliberately use a NUL as a sentinel or composite-key separator,
 * written as the `\x00` escape. Listed so a future "cleanup" that deletes the
 * escape — silently changing a key separator to nothing, or a sentinel to a
 * collidable plain string — fails here instead of in production.
 *
 * Removing a sentinel for real is fine: delete its row in the same commit.
 */
const SENTINEL_SITES = [
  'packages/core/src/agent-loop/history.ts',
  'packages/wiring/src/voice-stack.ts',
  'packages/a2a/src/task-store.ts',
  'apps/web-api/src/services/voice.service.ts',
  'apps/web/src/features/renderers/resolver.tsx',
];

function walkTextFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTextFiles(full));
    else if (TEXT_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

describe('source hygiene: no raw NUL bytes', () => {
  it('no source file under packages/, apps/ or extensions/ contains a literal 0x00', () => {
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walkTextFiles(dir)) {
        const bytes = readFileSync(file);
        const at = bytes.indexOf(0);
        if (at === -1) continue;
        const line = bytes.subarray(0, at).toString('utf-8').split('\n').length;
        const count = bytes.filter((b) => b === 0).length;
        offenders.push(
          `${relative(ROOT, file)}:${line}  (${count} NUL byte(s), first at byte ${at})`,
        );
      }
    }

    expect(
      offenders,
      [
        'Literal NUL (0x00) bytes found in source. ripgrep treats such a file as binary and',
        'SKIPS IT SILENTLY — every recursive `rg` in this repo returns zero hits for the whole',
        'file, which reads exactly like "this symbol has no callers". That has already produced',
        'wrong conclusions.',
        '',
        "Write the escape instead: '\\x00' (or '\\0'). It compiles to the identical U+0000 code",
        'unit in both quoted strings and template literals, so the runtime value is unchanged —',
        'only `rg` can tell them apart, which is the whole point.',
        '',
        'Offenders:',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('the known NUL sentinels still spell their separator as an escape', () => {
    const missing = SENTINEL_SITES.filter(
      (rel) => !readFileSync(join(ROOT, rel), 'utf-8').includes('\\x00'),
    );

    expect(
      missing,
      [
        'These modules use a NUL as a sentinel or composite-key separator, and the escape is gone.',
        'Dropping it is not cosmetic: a key separator becomes the empty string (so `a` + `bc` and',
        '`ab` + `c` collide) and a sentinel becomes a plain string a user could supply.',
        '',
        'If the sentinel was removed on purpose, delete its row from SENTINEL_SITES in this file.',
        'If not, restore the \\x00 escape — never a literal 0x00 byte (see the first test).',
        '',
        'Missing:',
        ...missing,
      ].join('\n'),
    ).toEqual([]);
  });
});
