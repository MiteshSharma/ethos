// Law 7 enforcement — `forbid_raw_filesystem_on_personality_boundary`.
//
// Per ARCHITECTURE.md §III Law 7: modules that read or write user-authored
// files on a personality's behalf MUST use the `Storage` contract (from
// `@ethosagent/types`). All other filesystem access — internal state,
// logs, pidfiles, database-driver files, system paths, build-time
// tooling, app composition roots — may use raw `node:fs` directly.
//
// Scope of this scan: `packages/` + `extensions/`. That covers everything
// reachable from tool execution and hook execution, which is where the
// personality boundary lives. Tools and hooks ship from extensions/tools-*
// and extensions/hooks-*; the framework engine (packages/core/) routes
// them; safety / wiring / storage primitives sit in packages/.
//
// `apps/` is deliberately NOT scanned: apps are composition roots. They
// boot servers, wire dependencies, and run CLI commands — none of which
// participate in the personality boundary directly. If a future change
// moves tool execution into an app (e.g. an in-process gateway running
// its own toolset bypassing the registry), the scan list here must be
// widened first.
//
// Documented exceptions inside the scanned tree — permanent carve-outs:
//
//   packages/storage-fs/         The Storage implementation itself. Obviously must
//                                 use node:fs — it IS the fs adapter.
//
//   extensions/session-sqlite/   @ethosagent/sqlite opens raw paths. WAL, FTS5, and
//   extensions/memory-vector/    atomic transactions don't fit a generic Storage
//   extensions/job-store/         interface without losing ACID guarantees.
//   extensions/delivery-ledger/   (job-store, delivery-ledger and session-cards
//   extensions/session-cards/     also mkdirSync the db's parent dir.
//                                 delivery-ledger's atomic redelivery claim is a
//                                 conditional UPDATE and session-cards derives its
//                                 per-session `seq` with MAX()+1 inside the insert
//                                 — both need a real transaction, not file IO.)
//
//   extensions/cron/src/index.ts  File lock via fs.open(..., 'wx'): exclusive
//                                 create is a POSIX-level primitive with no
//                                 equivalent in the Storage interface.
//
//   extensions/claw-migrate/     copyFile preserves byte-for-byte content including
//   src/index.ts                 file metadata. Storage models text (utf-8 strings);
//                                 binary copy semantics aren't in scope.
//
//   extensions/skills/           statSync walks $PATH looking for executable
//   src/skill-compat.ts          binaries. Not a ~/.ethos/ operation — explicitly
//                                 out of scope per the storage abstraction plan.
//
//   extensions/skills/           lstat checks for symlinks before reading
//   src/file-context-injector.ts discovery files (AGENTS.md, CLAUDE.md, SOUL.md)
//                                 from the user's project directory (ctx.workingDir),
//                                 not ~/.ethos/. Storage scopes to ~/.ethos/ only;
//                                 symlink-refusal on an arbitrary project path
//                                 requires raw lstat (Storage.mtime follows symlinks).
//
//   extensions/gateway/          lstat refuses symlinked path-based outbound media
//   src/media.ts                 (W3.2) before it reaches an adapter — an
//                                 exfiltration guard on an ARBITRARY tool-produced
//                                 path, not ~/.ethos/. Same rationale as the skills
//                                 file-context-injector: Storage scopes to ~/.ethos/
//                                 and follows symlinks, so symlink-refusal on an
//                                 arbitrary path needs raw lstat.
//
//   extensions/tools-code/       Textual false positive: the `node:fs` import sits
//   src/shim/js-shim.ts          inside a String.raw literal — it is the
//                                 CONTAINER-side shim client source delivered at
//                                 exec time (tools-as-code-api Lane A), not a host
//                                 import. The module itself performs no filesystem
//                                 access at all.
//
// If you need to add a new exception, document WHY here and in CLAUDE.md before
// adding it to ALLOWED_PATHS below. The default answer for code on the
// personality boundary is "use Storage."

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
  'packages/safety/',
  'packages/wiring/',
  'extensions/session-sqlite/',
  'extensions/memory-vector/',
  'extensions/job-store/',
  'extensions/delivery-ledger/',
  'extensions/session-cards/',
  'extensions/voice-providers/',
  'extensions/agent-mesh/',
  'extensions/llm-codex/',
  'extensions/plugin-loader/',
  'extensions/skill-evolver/',
  'extensions/team-supervisor/',
  'extensions/tools-process/',
];

// Specific files (relative to ROOT) that are permitted to import node:fs.
const ALLOWED_FILES = new Set([
  'extensions/cron/src/index.ts',
  'extensions/claw-migrate/src/index.ts',
  'extensions/skills/src/skill-compat.ts',
  'extensions/skills/src/file-context-injector.ts',
  'extensions/gateway/src/media.ts',
  'extensions/skills/src/env-resolver.ts',
  'extensions/execution-docker/src/index.ts',
  'extensions/goal-store/src/index.ts',
  'extensions/kanban-store/src/index.ts',
  'extensions/platform-whatsapp/src/session-store.ts',
  'extensions/request-dump/src/index.ts',
  'extensions/tools-code/src/shim/js-shim.ts',
]);

// Matches any static or dynamic import of node:fs or node:fs/promises.
const RAW_FS = /(?:from\s+['"]|import\s*\(\s*['"])node:fs(?:\/promises)?['"]/;

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

describe('Law 7: no raw node:fs imports on the personality boundary', () => {
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
