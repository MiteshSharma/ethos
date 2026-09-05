import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ScopedStorage } from '@ethosagent/storage-fs';
import type { Storage, StorageDirEntry } from '@ethosagent/types';

/**
 * What the `check:` verbs need from the outside world (ground-truth
 * verification R4).
 *
 * A port rather than ambient filesystem access, for two reasons. The verifier
 * stays a pure decision function that a test can drive without a tmpdir; and
 * the one place that decides WHERE a relative check path lands — the workdir —
 * becomes a construction argument instead of whatever cwd the process happens
 * to hold when a ticket is completed.
 *
 * The three file operations are separate on purpose. `file_exists` and
 * `file_min_bytes` ask metadata questions, and answering them by reading a
 * whole file turns `check: file_exists dist/bundle.js` into I/O and heap
 * proportional to a build artifact.
 *
 * EVERY file operation THROWS when the workdir is missing, when the path
 * escapes it, when the path is a DIRECTORY rather than a file, or on any error
 * that is not "no such file". The verifier turns a throw into a rejection: a
 * check that could not be settled must never read as passed.
 */
export interface CheckProbe {
  /** The directory relative check paths resolve against. Named in rejections. */
  readonly workdir: string;
  /** Is there a FILE at this path? Metadata only — nothing is read. A
   *  directory of that name is not one, and throws rather than answering. */
  exists(path: string): Promise<boolean>;
  /** Byte length, or `null` when the path does not exist. */
  size(path: string): Promise<number | null>;
  /** Does the file hold `substring`? `null` when the path does not exist. */
  contains(path: string, substring: string): Promise<boolean | null>;
  /**
   * Run an already-allowlisted argv in the workdir and resolve to its exit
   * code. Takes argv, never a command string: there is no shell here, so `;`,
   * `&&` and `$(…)` in a check line are inert arguments rather than a second
   * command the allowlist never saw.
   *
   * THROWS when no execution route was injected. A `run` check nobody can
   * execute is not a check that passed — same fail-closed rule as every file
   * verb above.
   */
  run(argv: readonly string[]): Promise<number>;
}

/**
 * The injected execution route for `run` checks (ground-truth verification,
 * FIX A).
 *
 * A PORT, with no default, and that is the whole point. This package used to
 * spawn the argv itself through `node:child_process`, which made ticket
 * completion a SECOND way to run a command on the host — one that inherited
 * none of the execution posture, mount confinement or binary allowlisting the
 * rest of the system routes through, and that future work on those controls
 * would not have known existed. The route is now supplied by wiring
 * (`createCheckRunExec` in `packages/wiring/src/grounding.ts`), which hands
 * over the SAME backend the `terminal` tool runs on. Absent — a standalone
 * embedder, a test — `run` fails closed rather than reaching for a shell.
 *
 * Resolves to the process exit code. Applying a timeout is the route's job:
 * it is the side that knows what it is running the command inside.
 */
export type CheckExec = (argv: readonly string[], cwd: string) => Promise<number>;

export interface CheckProbeOptions {
  storage: Storage;
  /** Absolute path. Team deployments pass the team directory, solo the
   *  personality's workdir (see `packages/wiring/src/compose-tools.ts`). */
  workdir: string;
  /**
   * Governed execution route for `run` checks. NO DEFAULT: absent, `run`
   * refuses. See `CheckExec`.
   */
  exec?: CheckExec;
}

/**
 * Ceiling on a file `file_contains` will scan.
 *
 * `Storage` has no bounded or streaming read — `readBytes` is all-or-nothing —
 * so the substring scan cannot be made incremental through the contract this
 * probe is required to use. What it CAN do is refuse to buffer something
 * enormous: over this size the check throws, and the verifier turns that into
 * a rejection naming the limit. Fail-closed, and the same rule the rest of
 * this file follows — a check that could not be settled is not a check that
 * passed.
 */
const MAX_CONTAINS_BYTES = 16 * 1024 * 1024;

/**
 * The production probe: `Storage` for the file verbs, the injected
 * `CheckExec` for `run` — this package spawns nothing itself.
 *
 * `Storage` rather than `node:fs` is not only the repo rule (CLAUDE.md) — it
 * is what lets a test hand the verifier an `InMemoryStorage` and assert every
 * file verb without touching a disk.
 */
export function createCheckProbe(opts: CheckProbeOptions): CheckProbe {
  const workdir = resolve(opts.workdir);
  const exec = opts.exec;

  /**
   * THE CONTAINMENT BOUNDARY, and the reason it is not written here.
   *
   * Acceptance criteria are AGENT-WRITABLE. `check: file_contains <path>
   * <substring>` is a repeatable one-bit oracle over any file this process can
   * read, so a `check:` path that resolves outside the workdir — `~/.ethos/`
   * secrets, a `.env`, an ssh key — is an exfiltration channel and not merely
   * an out-of-scope check.
   *
   * Lexical resolution alone does not close it: a symlink planted inside the
   * workdir is a filesystem fact, and `resolve()` is a string operation.
   * `ScopedStorage` already walks every path segment below the allowed prefix
   * with `lstat`, follows the first link it finds, and re-judges containment
   * against where the link actually lands — the same algorithm as `checkReach`
   * in `packages/core/src/scoped/scoped-fs.ts` and `containedPath` in
   * `packages/wiring/src/backup/restore.ts`, which carry "these must change
   * together" notes for exactly this reason. A fourth copy here would be a
   * fourth thing to keep in step, so this probe REUSES the third rather than
   * writing one: every file read below goes through `scoped`, whose read scope
   * is the workdir and whose write scope is empty (the probe never writes).
   *
   * Like all three, this closes MISDIRECTION and not TOCTOU.
   */
  const scoped = new ScopedStorage(opts.storage, { read: [workdir], write: [] });

  /**
   * Resolve a check path inside the workdir.
   *
   * The prefix test here is NOT the boundary — `scoped` is. It is a message:
   * an author who wrote `../../etc/passwd` gets told the path escaped the
   * workdir, in the workdir's own terms, rather than a generic storage
   * refusal. Anything that gets past it is still judged, symlinks and all, by
   * the scope on every subsequent read.
   */
  async function locate(path: string): Promise<string> {
    await requireWorkdir();
    const full = resolve(isAbsolute(path) ? path : join(workdir, path));
    if (full !== workdir && !full.startsWith(workdir + sep)) {
      throw new Error(`path escapes the verification workdir (${workdir}): ${path}`);
    }
    return full;
  }

  async function requireWorkdir(): Promise<void> {
    if (!(await opts.storage.exists(workdir))) {
      throw new Error(`verification workdir does not exist: ${workdir}`);
    }
  }

  /**
   * The directory metadata for a path that already exists, and THE PLACE A
   * DIRECTORY IS REFUSED.
   *
   * Every verb below is a FILE verb, and `exists()` on its own cannot say so:
   * `Storage.exists` is true for a directory, so `check: file_exists
   * dist/report.pdf` used to pass on a DIRECTORY named `dist/report.pdf` and
   * move the ticket to done on an artifact nobody produced. `listEntries` is
   * the only call in the contract that reports a type — there is no `stat` —
   * so the type question and the size question are answered by the same call,
   * and the extra listing is what a `file_exists` check costs to be honest.
   *
   * Refused by THROWING, not by answering `false`/`null`, for the reason this
   * file's header gives: a directory is not "no such file", and a rejection
   * reading `no such file under /work` when the path is plainly there sends
   * the author looking for the wrong problem. The verifier turns the throw
   * into a rejection naming what it found.
   *
   * `size` stays optional: `StorageDirEntry.size` is omitted by backends
   * without stat semantics (`InMemoryStorage`, object stores), so this is an
   * attempt at a size and an answer about a type. `size()` falls back to a
   * read when the size comes back empty; on `FsStorage` — the production
   * wiring — it always answers, which is what keeps `file_min_bytes` off the
   * heap.
   */
  async function fileEntryOf(full: string): Promise<StorageDirEntry | undefined> {
    // The workdir itself is a directory, and it is also the one path whose
    // parent this probe may not list — the read scope stops here.
    if (full === workdir) throw new Error(`${full} is a directory, not a file`);
    const parent = dirname(full);
    const name = full.slice(parent.length + 1);
    const entries = await scoped.listEntries(parent);
    const entry = entries.find((e) => e.name === name);
    if (entry?.isDir === true) {
      throw new Error(`${full} is a directory, not a file`);
    }
    return entry;
  }

  return {
    workdir,
    async exists(path: string): Promise<boolean> {
      // `scoped.exists` first, and not only for the answer: it is the call
      // that judges the LEAF for symbolic containment. Listing the parent
      // directory judges the parent, so a symlinked leaf would sail past a
      // listing-only check.
      const full = await locate(path);
      if (!(await scoped.exists(full))) return false;
      await fileEntryOf(full);
      return true;
    },
    async size(path: string): Promise<number | null> {
      const full = await locate(path);
      if (!(await scoped.exists(full))) return null;
      const known = (await fileEntryOf(full))?.size;
      if (known !== undefined) return known;
      // The backend does not report sizes. Reading is the only way left to
      // measure, and on such a backend the bytes are not on a disk anyway.
      return (await scoped.readBytes(full))?.length ?? null;
    },
    async contains(path: string, substring: string): Promise<boolean | null> {
      const full = await locate(path);
      if (!(await scoped.exists(full))) return null;
      const known = (await fileEntryOf(full))?.size;
      if (known !== undefined && known > MAX_CONTAINS_BYTES) {
        throw new Error(
          `file is ${known} bytes, larger than the ${MAX_CONTAINS_BYTES}-byte file_contains limit`,
        );
      }
      const bytes = await scoped.readBytes(full);
      if (bytes === null) return null;
      return new TextDecoder().decode(bytes).includes(substring);
    },
    async run(argv: readonly string[]): Promise<number> {
      await requireWorkdir();
      if (exec === undefined) {
        throw new Error('no execution route is configured for `run` checks');
      }
      return exec(argv, workdir);
    },
  };
}
