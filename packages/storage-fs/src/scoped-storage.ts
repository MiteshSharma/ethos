// Raw `node:fs` here is the documented Law 7 carve-out for this package: it
// IS the filesystem adapter. `Storage` follows symlinks and exposes no
// `lstat`, so the symbolic-containment check below cannot be expressed
// through the contract it guards. Sync (`lstatSync`, not `fs/promises`)
// because `check()` is synchronous and every Storage method calls it before
// awaiting anything.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BoundaryError,
  type Storage,
  type StorageDirEntry,
  type StorageRemoveOptions,
  type StorageWriteOptions,
} from '@ethosagent/types';

/** Bound on symlink hops followed while validating a single path. */
const MAX_SYMLINK_HOPS = 32;

export interface ScopedStorageScope {
  /** Absolute path prefixes that may be read. */
  read: readonly string[];
  /** Absolute path prefixes that may be written / mutated. */
  write: readonly string[];
  /**
   * Ch.5 — universal always-deny prefixes. Match these and the request
   * fails regardless of allow rules. This is the floor: a personality
   * config that lists `~/` in `allow` still cannot read `~/.ssh`. Lives
   * in code (default list provided by the wiring layer); user can extend
   * but cannot remove built-in entries.
   */
  alwaysDeny?: readonly string[];
}

/**
 * Decorator over Storage that enforces a per-scope read/write allowlist
 * plus the Ch.5 universal always-deny floor. Used by tools-file to bound
 * a personality's filesystem reach to its own directory + cwd.
 *
 * Order of checks (any deny wins over any allow):
 *   1. always-deny — request rejected.
 *   2. allow allowlist — request rejected if no prefix matches.
 *   3. symbolic containment — layers 1 and 2 are lexical, and `resolve()`
 *      is a string operation while a symlink is a filesystem fact. A link
 *      planted inside an allowed prefix pointing outside it passes both.
 *      Layer 3 walks the path segment by segment BELOW the matched prefix
 *      and follows any link it finds, re-judging layers 1 and 2 against
 *      where the link actually lands (G11).
 *
 * This closes **misdirection**, not **TOCTOU**: an attacker who can swap a
 * path between this walk and the subsequent open still wins, and closing
 * that needs container-level remediation.
 *
 * Layer 3 is a deliberate DUPLICATE of `checkReach` in
 * `packages/core/src/scoped/scoped-fs.ts` — the same guarantee enforced at
 * the other personality filesystem boundary. It is not shared code because
 * `@ethosagent/core` may not import `@ethosagent/storage-fs` at runtime
 * (storage-fs is the security kernel; core is not, and core depends on it
 * only as a devDependency). A THIRD copy —
 * `containedPath`/`followFirstSymlink` in
 * `packages/wiring/src/backup/restore.ts` — guards the backup restore's
 * destination paths under the Ethos data directory, duplicated for the same
 * reason: `packages/wiring` is a different layer. A FOURTH is `reachable` in
 * `apps/web-api/src/services/documents.service.ts`, guarding the
 * operator-supplied Documents root. **All four must change together.**
 *
 * The fourth is NOT equivalent today. It walks with async `lstat` from
 * `node:fs/promises` — so an `lstatSync` grep misses it — and swallows every
 * stat error with `.catch(() => null)`, then CONTINUES the walk, where the
 * other three abort on anything but ENOENT. That is the fail-open commit
 * 69e7b26d removed from `restore.ts`; bringing it into line is a pending fix.
 *
 * Prefixes are matched literally — there is no glob expansion. Pass paths
 * that end in `/` for directory scopes; ScopedStorage normalizes them so
 * `/a/b` does not also match `/a/bc/`.
 */
export class ScopedStorage implements Storage {
  private readonly readPrefixes: string[];
  private readonly writePrefixes: string[];
  private readonly denyPrefixes: string[];

  constructor(
    private readonly inner: Storage,
    scope: ScopedStorageScope,
  ) {
    this.readPrefixes = scope.read.map(normalizePrefix);
    this.writePrefixes = scope.write.map(normalizePrefix);
    this.denyPrefixes = (scope.alwaysDeny ?? []).map(normalizePrefix);
  }

  private check(rawPath: string, kind: 'read' | 'write'): void {
    // Normalize the path before checking against prefixes so that `..`
    // segments cannot bypass the prefix-based allowlist.
    const path = resolve(rawPath);
    if (isPathAllowed(path, this.denyPrefixes)) {
      throw new BoundaryError(kind, path, this.denyPrefixes, 'always-deny floor');
    }
    const allowed = kind === 'read' ? this.readPrefixes : this.writePrefixes;
    let prefix = matchAllowedPrefix(path, allowed);
    if (prefix === null) {
      throw new BoundaryError(kind, path, allowed);
    }

    // Symbolic containment. The lexical layers above are judged FIRST and
    // with no filesystem access at all: a path outside the allowlist is
    // refused on its string form and never reaches an `lstat`, so the
    // boundary leaks no existence information about paths it does not
    // govern. Only a path already inside the allowlist gets asked whether
    // it *really* is.
    //
    // Each hop rewrites the path through one link and re-walks from the
    // (possibly different) allowed prefix that now contains it, so a link
    // whose own target sits behind another link is resolved too. The
    // resolved target is never named in the error: the boundary must not
    // hand back a path it just refused.
    let current = path;
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      const next = followFirstSymlink(prefix, current);
      if (next === null) return;
      const nextPrefix = matchAllowedPrefix(next, allowed);
      if (nextPrefix === null || isPathAllowed(next, this.denyPrefixes)) {
        throw new BoundaryError(
          kind,
          path,
          allowed,
          'resolves outside the allowlist through a symbolic link',
        );
      }
      current = next;
      prefix = nextPrefix;
    }
    throw new BoundaryError(kind, path, allowed, 'follows too many symbolic links to resolve');
  }

  async read(path: string): Promise<string | null> {
    this.check(path, 'read');
    return this.inner.read(path);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    this.check(path, 'read');
    return this.inner.readBytes(path);
  }

  async exists(path: string): Promise<boolean> {
    this.check(path, 'read');
    return this.inner.exists(path);
  }

  async mtime(path: string): Promise<number | null> {
    this.check(path, 'read');
    return this.inner.mtime(path);
  }

  async list(dir: string): Promise<string[]> {
    this.check(dir, 'read');
    return this.inner.list(dir);
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    this.check(dir, 'read');
    return this.inner.listEntries(dir);
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    this.check(path, 'write');
    return this.inner.write(path, content, opts);
  }

  async append(path: string, content: string): Promise<void> {
    this.check(path, 'write');
    return this.inner.append(path, content);
  }

  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    this.check(path, 'write');
    return this.inner.writeAtomic(path, content, opts);
  }

  async mkdir(dir: string): Promise<void> {
    this.check(dir, 'write');
    return this.inner.mkdir(dir);
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    this.check(path, 'write');
    return this.inner.remove(path, opts);
  }

  async rename(from: string, to: string): Promise<void> {
    this.check(from, 'write');
    this.check(to, 'write');
    return this.inner.rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.check(path, 'write');
    return this.inner.chmod(path, mode);
  }
}

function normalizePrefix(prefix: string): string {
  // A prefix matches any path where prefix is followed by '/' or end-of-string,
  // OR where the path equals the prefix exactly. We keep the prefix as-given
  // (with or without trailing slash) and handle the boundary in isPathAllowed.
  return prefix;
}

function isPathAllowed(path: string, prefixes: readonly string[]): boolean {
  return matchAllowedPrefix(path, prefixes) !== null;
}

/**
 * The matched prefix containing `path` in slash-less root form, or null when
 * no prefix contains it. Purely lexical — no filesystem access. The root
 * form is what the symlink walk uses as its floor: only segments BELOW it
 * are inspected.
 */
function matchAllowedPrefix(path: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (path === prefix) return prefix.endsWith('/') ? prefix.slice(0, -1) || sep : prefix;
    const withoutSlash = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // Allow the directory itself (without trailing slash) — needed so
    // `mkdir(<personality-dir>)` and `list(<personality-dir>)` succeed
    // when the configured prefix has a trailing slash.
    if (path === withoutSlash) return withoutSlash || sep;
    const withSlash = `${withoutSlash}/`;
    if (path.startsWith(withSlash)) return withoutSlash || sep;
  }
  return null;
}

/**
 * Walk `target` one segment at a time below `prefixRoot`, `lstat`ing each.
 * Returns the path rewritten through the FIRST symbolic link found (that
 * link's target plus the remaining segments), or null when the walk crosses
 * no link.
 *
 * Per-segment, not leaf-only: a symlinked PARENT escapes the allowlist
 * behind a perfectly ordinary leaf. A missing segment is not a link —
 * `lstat` finding nothing is the normal case for a write to a file that does
 * not exist yet, and nothing can live below a segment that is absent, so the
 * walk stops. Only the portion BELOW the matched prefix is walked: segments
 * above it are the operator's own layout (`/var` → `/private/var` on macOS),
 * not an escape.
 *
 * Mirror of `followFirstSymlink` in `packages/core/src/scoped/scoped-fs.ts`.
 */
function followFirstSymlink(prefixRoot: string, target: string): string | null {
  const rel = relative(prefixRoot, target);
  if (rel === '') return null;

  const segments = rel.split(sep);
  let cursor = prefixRoot;
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i] ?? '');
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (!stat.isSymbolicLink()) continue;
    const linkTarget = resolve(dirname(cursor), readlinkSync(cursor));
    return resolve(join(linkTarget, ...segments.slice(i + 1)));
  }
  return null;
}
