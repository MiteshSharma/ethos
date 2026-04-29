// Storage abstraction — plan criterion 2.
//
// Library code (packages/*, extensions/*) must NOT import from `node:fs` or
// `node:fs/promises` directly. All ~/.ethos/ reads and writes go through the
// `Storage` interface from `@ethosagent/types` so that:
//   - Tests can use InMemoryStorage without tmpdir scaffolding.
//   - ScopedStorage enforces per-personality path allowlists at one chokepoint.
//   - AuditedStorage (future) can log every access without patching each call site.
//
// Documented exceptions — these are permanent carve-outs, not technical debt:
//
//   packages/storage-fs/         The Storage implementation itself. Obviously must
//                                 use node:fs — it IS the fs adapter.
//
//   extensions/session-sqlite/   better-sqlite3 opens raw paths. WAL, FTS5, and
//   extensions/memory-vector/    atomic transactions don't fit a generic Storage
//                                 interface without losing ACID guarantees.
//
//   extensions/cron/src/index.ts  File lock via fs.open(..., 'wx'): exclusive
//                                 create is a POSIX-level primitive with no
//                                 equivalent in the Storage interface.
//
//   extensions/claw-migrate/     copyFile preserves byte-for-byte content including
//   src/index.ts                 file metadata. Storage models text (utf-8 strings);
//                                 binary copy semantics aren't in scope.
//
//   extensions/web-api/          Serves the built apps/web/dist from disk. This is
//   src/routes/static.ts         the web server's static-file handler, not a
//                                 ~/.ethos/ operation — Tier 4 defer per plan.
//
//   extensions/skills/           statSync walks $PATH looking for executable
//   src/skill-compat.ts          binaries. Not a ~/.ethos/ operation — explicitly
//                                 out of scope per the storage abstraction plan.
//
// If you need to add a new exception, document WHY here and in CLAUDE.md before
// adding it to ALLOWED_PATHS below. The default answer to "can I use node:fs?"
// in library code is NO.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

// Directories to scan (library code only — CLI surface code has different rules).
const SCAN_DIRS = [join(ROOT, 'packages'), join(ROOT, 'extensions')];

// Path prefixes (relative to ROOT) that are permitted to import node:fs.
// Match is prefix-based: a file is allowed if its relative path starts with
// any of these strings.
const ALLOWED_PREFIXES = [
  'packages/storage-fs/',
  'extensions/session-sqlite/',
  'extensions/memory-vector/',
];

// Specific files (relative to ROOT) that are permitted to import node:fs.
const ALLOWED_FILES = new Set([
  'extensions/cron/src/index.ts',
  'extensions/claw-migrate/src/index.ts',
  'extensions/web-api/src/routes/static.ts',
  'extensions/skills/src/skill-compat.ts',
]);

// Matches any static or dynamic import of node:fs or node:fs/promises.
const RAW_FS = /(?:from|import)\s*\(\s*['"]node:fs(?:\/promises)?['"]/;

function isAllowed(absPath: string): boolean {
  const rel = relative(ROOT, absPath).replace(/\\/g, '/');
  if (ALLOWED_FILES.has(rel)) return true;
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walkTs(full));
    } else if (extname(entry) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('storage abstraction: no raw node:fs imports in library code', () => {
  it('packages/ and extensions/ do not import node:fs outside the documented allowlist', () => {
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walkTs(dir)) {
        if (isAllowed(file)) continue;
        const src = readFileSync(file, 'utf-8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (RAW_FS.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
          }
        }
      }
    }

    expect(
      offenders,
      [
        'Library code must use Storage (from @ethosagent/types) instead of node:fs directly.',
        'To add a new exception, document the reason in apps/ethos/src/__tests__/no-raw-fs.test.ts',
        'and in CLAUDE.md before adding to ALLOWED_PREFIXES or ALLOWED_FILES.',
        '',
        'Offenders:',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });
});
