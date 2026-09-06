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
//   extensions/delivery-ledger/   (job-store, delivery-ledger, session-cards, call-log
//   extensions/session-cards/     and notify-queue also mkdirSync the db's parent dir.
//   extensions/call-log/          delivery-ledger's atomic redelivery claim is a
//   extensions/notify-queue/      conditional UPDATE and session-cards derives its
//   extensions/inbound-dedup/     per-session `seq` with MAX()+1 inside the insert
//   extensions/channel-transcript-sqlite/
//                                 — both need a real transaction, not file IO.
//                                 notify-queue's read-and-consume is the same shape:
//                                 a SELECT then UPDATE inside one transaction, and
//                                 inbound-dedup's check-and-record is one
//                                 `INSERT OR IGNORE` whose affected-row count IS
//                                 the answer. channel-transcript-sqlite mkdirSyncs
//                                 the same way, and its `pruneChannelTranscript`
//                                 additionally existsSyncs the db file so a prune on
//                                 a deployment that never enabled observe mode is a
//                                 no-op rather than a call that CREATES an empty
//                                 database on every machine.)
//
//   packages/a2a/                Same rationale as the SQLite stores above:
//   src/sqlite-task-store.ts     SQLiteA2aTaskStore (T1.6) opens a raw path via
//                                 @ethosagent/sqlite and mkdirSync's the db's
//                                 parent dir, so an async task's terminal state
//                                 and idempotency key survive an `ethos serve`
//                                 restart.
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
//   packages/core/               lstat/readlink walk the segments of a path that has
//   src/scoped/scoped-fs.ts      already passed the lexical fs_reach check, to refuse
//                                 a symlink that resolves outside the reach (G11).
//                                 This IS the personality filesystem boundary, not a
//                                 module sitting behind it: Storage follows symlinks
//                                 and exposes no lstat, so the check cannot be
//                                 expressed through the contract it guards. Same
//                                 rationale as gateway/media.ts and
//                                 web-api/documents.service.ts.
//
//   extensions/gateway/          lstat refuses symlinked path-based outbound media
//   src/media.ts                 (W3.2) before it reaches an adapter — an
//                                 exfiltration guard on an ARBITRARY tool-produced
//                                 path, not ~/.ethos/. Same rationale as the skills
//                                 file-context-injector: Storage scopes to ~/.ethos/
//                                 and follows symlinks, so symlink-refusal on an
//                                 arbitrary path needs raw lstat.
//
//   extensions/gateway/          ffmpeg transcodes FILES, not buffers: the stage
//   src/transcode.ts             writes the source bytes to a scratch path, runs
//                                 the binary, and reads the output back. Those
//                                 paths live in `os.tmpdir()`, never `~/.ethos/`
//                                 — same carve-out as command-tts in
//                                 extensions/voice-providers/, which shells out
//                                 the same way for the same reason.
//
//   extensions/gateway/          The ambient channel digest's cross-process run
//   src/channel-digest-lock.ts   sentinel: an advisory `wx`-flag exclusive-create
//                                 lock with pid-liveness stale detection, so two
//                                 gateways sharing one `~/.ethos` cannot both
//                                 digest the same watched rooms and clobber each
//                                 other's cursor file. The same primitive and the
//                                 same carve-out as `acquireRegistryLock`
//                                 (extensions/agent-mesh/) and `acquireBackupLock`
//                                 (packages/wiring/src/backup-schedule.ts) — an
//                                 atomic create-if-absent has no equivalent in the
//                                 Storage interface, because `exists()` then
//                                 `write()` is the exact race the lock closes.
//                                 Copied rather than imported: packages/wiring sits
//                                 ABOVE extensions/ in the layer model, so its
//                                 version is not reachable from here. Everything
//                                 else the digest touches still goes through Storage.
//
//   extensions/tools-code/       Textual false positive: the `node:fs` import sits
//   src/shim/js-shim.ts          inside a String.raw literal — it is the
//                                 CONTAINER-side shim client source delivered at
//                                 exec time (tools-as-code-api Lane A), not a host
//                                 import. The module itself performs no filesystem
//                                 access at all.
//
//   extensions/platform-callcapture/  existsSync checks for the compiled
//   src/detector.ts                   `mic-detector` CoreAudio helper binary
//                                      shipped alongside this package
//                                      (native/bin/), so a missing build can
//                                      throw a clear "run this command" error
//                                      instead of a bare ENOENT. Not a
//                                      ~/.ethos/ operation — same rationale as
//                                      skills/skill-compat.ts.
//
//   extensions/platform-callcapture/  Same rationale as detector.ts above,
//   src/audio-process.ts              generalized: existsSync checks for
//                                      either of Phase 3's two native
//                                      capture binaries (the vendored
//                                      `audiotee`, native/vendor/, or the
//                                      compiled `mic-capture`, native/bin/)
//                                      before spawning, so a missing build
//                                      throws a clear "run this command"
//                                      error instead of a bare ENOENT. Not a
//                                      ~/.ethos/ operation.
//
//   extensions/platform-callcapture/  Phase 4's combined dependency preflight
//   src/preflight.ts                  (`checkCallCaptureDependencies`, T5):
//                                      existsSync checks the same four
//                                      native binaries detector.ts/
//                                      audio-process.ts/notification.ts
//                                      check individually, before a
//                                      notification or capture attempt
//                                      starts. Same rationale — not a
//                                      ~/.ethos/ operation.
//
//   extensions/platform-callcapture/  Cross-process ownership lock
//   src/ownership.ts                  (`tryClaimOwnership`) so `ethos serve`
//                                      and `ethos gateway` never both run a
//                                      live `CallCaptureDaemon` at once. Same
//                                      carve-out category as
//                                      `extensions/team-supervisor/src/pid.ts`
//                                      (already covered by that whole
//                                      directory's prefix entry below): an
//                                      atomic PID-claim file is
//                                      process-management state, not
//                                      `~/.ethos/` personality data — an
//                                      exclusive-create + liveness-check +
//                                      stale-cleanup lock has no equivalent
//                                      in the Storage interface.
//
//   extensions/platform-callcapture/  Same rationale as detector.ts above:
//   src/indicator.ts                  existsSync checks for the compiled
//                                      `capture-indicator` AppKit helper
//                                      binary (native/bin/) before spawning
//                                      it, so a missing build throws a clear
//                                      "run this command" error instead of a
//                                      bare ENOENT. Not a ~/.ethos/ operation.
//
//   extensions/platform-callcapture/  Same rationale as detector.ts above:
//   src/notification.ts               existsSync checks for the compiled
//                                      `capture-offer-card` binary shipped
//                                      alongside this package (native/bin/)
//                                      before spawning it, so a missing
//                                      build throws a clear "run this
//                                      command" error instead of a bare
//                                      ENOENT. Not a ~/.ethos/ operation.
//
//   extensions/execution-pi/       Creating a Pi run's workspace IS a
//   src/worktree.ts                 `git worktree add`: the git binary writes a
//                                    whole tree, which no Storage method can
//                                    express, and the surrounding mkdir/exists
//                                    checks are that same operation's
//                                    bookkeeping. Same category as the SQLite
//                                    stores' mkdirSync of a database's parent
//                                    directory.
//
//   extensions/execution-pi/       existsSync answers "is this machine set up
//   src/availability.ts             to run Pi at all" against the operator's
//                                    Pi credential file, which is never opened
//                                    and never read — the container gets it as
//                                    a read-only mount. Same rationale as
//                                    platform-callcapture/src/detector.ts's
//                                    binary-presence check; not a ~/.ethos/
//                                    operation.
//
//   extensions/execution-       Same rationale as execution-pi/src/
//   coding-agents/src/          worktree.ts above, copied not imported
//   worktree.ts                 (D-ACP1: no shared file between the two
//                                packages): creating an ACP-agent run's
//                                workspace IS a `git worktree add`, and the
//                                surrounding mkdir/exists checks are that
//                                same operation's bookkeeping. (This
//                                package's availability.ts needs no entry
//                                here — it probes with `spawn` only, no
//                                `node:fs` import at all.)
//
//   extensions/execution-ssh/   accessSync(path, W_OK) answers "can this
//   src/index.ts                 machine actually KEEP a host key it learns"
//                                before an `accept-new` connection is
//                                spawned. It is a pre-flight probe on an
//                                OPERATOR-supplied path, resolved the way ssh
//                                itself resolves it: `execution.ssh.
//                                knownHostsFile` when set (Ethos passes it as
//                                a command-line `-o`, which outranks the
//                                config file), otherwise the first entry of
//                                the `userknownhostsfile` line in `ssh -G`
//                                output for that destination
//                                (`knownHostsFromSshConfig`), which honours
//                                the operator's `~/.ssh/config` including
//                                `Include` and `Match` blocks and so can name
//                                a path neither Ethos nor the operator typed
//                                here. `~/.ssh/known_hosts`
//                                (`DEFAULT_KNOWN_HOSTS`) is only the fail-open
//                                fallback for a `-G` this process cannot read
//                                — no ssh binary, non-zero status, timeout, no
//                                `userknownhostsfile` line, or a quoted path
//                                it will not split. Whichever path that
//                                resolution names lives outside `~/.ethos/`
//                                entirely and is read by the ssh binary,
//                                never by Ethos:
//                                nothing is opened, nothing is parsed, no
//                                personality data passes through it. Storage
//                                could not express it even if the path were
//                                in scope, because Storage has no writability
//                                probe at all: `exists()` answers a different
//                                question (the file legitimately does not
//                                exist yet — accept-new creates it), and the
//                                only way to ask Storage whether a write
//                                would succeed is to PERFORM one, which would
//                                mean Ethos writing into the operator's
//                                known_hosts to find out whether ssh could.
//                                Same category as platform-callcapture/
//                                src/detector.ts's binary-presence existsSync
//                                and web-api's documents.service.ts lstat: a
//                                fact about the host filesystem that the
//                                storage contract does not model. It has to
//                                be asked BEFORE the spawn — OpenSSH warns
//                                and CONTINUES when it cannot record a key
//                                (verified 9.6p1: "Failed to add the host to
//                                the list of known hosts", remote command
//                                ran, exit 0), so the alternative is inferring
//                                a silent loss of pinning from a warning line
//                                after the command has already run remotely.
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
  'extensions/call-log/',
  'extensions/notify-queue/',
  'extensions/inbound-dedup/',
  'extensions/channel-transcript-sqlite/',
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
  'packages/core/src/scoped/scoped-fs.ts',
  'extensions/cron/src/index.ts',
  'extensions/claw-migrate/src/index.ts',
  'extensions/skills/src/skill-compat.ts',
  'extensions/skills/src/file-context-injector.ts',
  'extensions/gateway/src/media.ts',
  'extensions/gateway/src/transcode.ts',
  'extensions/gateway/src/channel-digest-lock.ts',
  'extensions/skills/src/env-resolver.ts',
  'extensions/execution-docker/src/index.ts',
  'extensions/execution-pi/src/worktree.ts',
  'extensions/execution-pi/src/availability.ts',
  'extensions/execution-coding-agents/src/worktree.ts',
  'extensions/execution-ssh/src/index.ts',
  'extensions/goal-store/src/index.ts',
  'extensions/kanban-store/src/index.ts',
  'extensions/platform-whatsapp/src/session-store.ts',
  'extensions/request-dump/src/index.ts',
  'extensions/tools-code/src/shim/js-shim.ts',
  'extensions/platform-callcapture/src/detector.ts',
  'extensions/platform-callcapture/src/audio-process.ts',
  'extensions/platform-callcapture/src/preflight.ts',
  'extensions/platform-callcapture/src/ownership.ts',
  'extensions/platform-callcapture/src/indicator.ts',
  'extensions/platform-callcapture/src/notification.ts',
  'packages/a2a/src/sqlite-task-store.ts',
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
