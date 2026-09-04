// Raw `node:fs` is deliberate here and is the documented exception, not an
// oversight: this is the filesystem boundary itself. `Storage` follows
// symlinks and exposes no `lstat`, so the symbolic-containment check below
// cannot be expressed through it — the same rationale that already licenses
// raw `node:fs` in `apps/web-api/src/services/documents.service.ts` and
// `extensions/gateway/src/media.ts`. Do not "fix" this back to Storage.
// Sync (`lstatSync`, not `fs/promises`) because `checkReach` is synchronous
// and called from both sync and async paths; making it async would ripple
// through the whole `ScopedFs` contract for no security gain.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { ScopedFs, ScopedFsEntry, Storage } from '@ethosagent/types';

/** Bound on symlink hops followed while validating a single path. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Scoped filesystem capability. Enforces three layers on every call:
 *
 *  1. **Non-overridable deny floor** — `alwaysDenyPaths` (injected at
 *     construction) lists `.ssh`, `.aws/credentials`, `/etc/passwd`,
 *     `/root`, etc. A path that touches any of these denies even when
 *     the capability and personality both grant the parent (mirror of
 *     `safety-network`'s cloud-metadata block).
 *
 *  2. **Declared reach allowlist** — the intersection of the tool's
 *     `capabilities.fs_reach` with the personality's `fs_reach`,
 *     resolved at registration time. Paths outside the allow set are
 *     rejected with `PATH_NOT_REACHABLE`.
 *
 *  3. **Symbolic containment** — layers 1 and 2 are lexical, and
 *     `normalize(resolve())` is a string operation while a symlink is a
 *     filesystem fact. A link planted inside an allowed prefix pointing
 *     outside it passes both. Layer 3 walks the path segment by segment
 *     below the matched prefix and follows any link it finds, re-judging
 *     layers 1 and 2 against where the link actually lands.
 *
 * This closes **misdirection**, not **TOCTOU**: an attacker who can swap a
 * path between this walk and the subsequent open still wins, and closing
 * that needs container-level remediation.
 *
 * The floor cannot be disabled by configuration. Tests that need to
 * exercise a forbidden path override `$HOME` before constructing the
 * wrapper.
 */
export class ScopedFsImpl implements ScopedFs {
  private readonly denyPaths: string[];

  constructor(
    private readonly storage: Storage,
    private readonly readPaths: Set<string>,
    private readonly writePaths: Set<string>,
    alwaysDenyPaths: string[] = [],
  ) {
    this.denyPaths = alwaysDenyPaths.map((p) => normalize(resolve(p)));
  }

  async read(path: string): Promise<string> {
    this.checkReach(path, this.readPaths, 'read');
    const content = await this.storage.read(path);
    if (content === null) throw new Error(`File not found: ${path}`);
    return content;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.checkReach(path, this.readPaths, 'read');
    const bytes = await this.storage.readBytes(path);
    if (bytes === null) throw new Error(`File not found: ${path}`);
    return bytes;
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    this.checkReach(path, this.writePaths, 'write');
    await this.storage.write(path, content);
  }

  async exists(path: string): Promise<boolean> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.exists(path);
  }

  async list(path: string): Promise<string[]> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.list(path);
  }

  async mtime(path: string): Promise<number | null> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.mtime(path);
  }

  async mkdir(dir: string): Promise<void> {
    this.checkReach(dir, this.writePaths, 'write');
    await this.storage.mkdir(dir);
  }

  async listEntries(dir: string): Promise<ScopedFsEntry[]> {
    this.checkReach(dir, this.readPaths, 'read');
    return this.storage.listEntries(dir);
  }

  private checkReach(path: string, allowed: Set<string>, kind: string): void {
    const canonical = normalize(resolve(path));

    // NB: the literal `PATH_NOT_REACHABLE:` prefix below is the contract
    // tools-file's `isReachError` consumer matches against. Do not change
    // the prefix without also updating consumers.
    //
    // Deny floor fires first — non-overridable, runs even when an
    // operator misconfigures fs_reach to include everything.
    if (this.hitsDenyFloor(canonical)) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" hits the always-deny floor`);
    }

    let prefix = matchAllowedPrefix(canonical, allowed);
    if (prefix === null) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} not permitted for ${path}`);
    }

    // Symbolic containment. Lexical containment above is judged FIRST and
    // with no filesystem access at all: a path outside the reach is refused
    // on its string form and never reaches an `lstat`, so the boundary
    // leaks no existence information about paths it does not govern. Only a
    // path already inside the reach gets asked whether it *really* is.
    //
    // Each hop rewrites the path through one link and re-walks from the
    // (possibly different) allowed prefix that now contains it, so a link
    // whose own target sits behind another link is resolved too.
    let current = canonical;
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      const next = followFirstSymlink(prefix, current);
      if (next === null) return;
      const nextPrefix = matchAllowedPrefix(next, allowed);
      if (nextPrefix === null || this.hitsDenyFloor(next)) {
        throw new Error(
          `PATH_NOT_REACHABLE: ${kind} of "${path}" resolves outside the allowlist through a symbolic link`,
        );
      }
      current = next;
      prefix = nextPrefix;
    }
    throw new Error(
      `PATH_NOT_REACHABLE: ${kind} of "${path}" follows too many symbolic links to resolve`,
    );
  }

  private hitsDenyFloor(canonical: string): boolean {
    return this.denyPaths.some(
      (deny) => canonical === deny || canonical.startsWith(deny.endsWith('/') ? deny : `${deny}/`),
    );
  }
}

/**
 * The canonical form of the first allowed prefix containing `canonical`, or
 * null when no prefix does. Purely lexical — no filesystem access.
 */
function matchAllowedPrefix(canonical: string, allowed: Iterable<string>): string | null {
  for (const prefix of allowed) {
    const canonicalPrefix = normalize(resolve(prefix));
    if (
      canonical === canonicalPrefix ||
      canonical.startsWith(canonicalPrefix.endsWith('/') ? canonicalPrefix : `${canonicalPrefix}/`)
    ) {
      return canonicalPrefix;
    }
  }
  return null;
}

// Layer 3 of `checkReach` above is a deliberate DUPLICATE of `ScopedStorage.check`
// in `packages/storage-fs/src/scoped-storage.ts` — the same symbolic-containment
// rule enforced at the other personality filesystem boundary. It is not shared
// code because `@ethosagent/core` may not import `@ethosagent/storage-fs` at
// runtime (storage-fs is the security kernel; core is not, and core depends on it
// only as a devDependency — ARCHITECTURE.md §II). A THIRD copy —
// `containedPath`/`followFirstSymlink` in `packages/wiring/src/backup/restore.ts` —
// guards the backup restore's destination paths under the Ethos data directory,
// duplicated for the same reason: `packages/wiring` is a different layer.
// **All three must change together:** a fix applied to one boundary and not the
// others leaves the escape open on whichever path the caller happens to take.
// The reciprocal notes live in `scoped-storage.ts`'s class doc and in
// `restore.ts`'s `followFirstSymlink` doc.

/**
 * Walk `target` one segment at a time below `prefixRoot`, `lstat`ing each.
 * Returns the path rewritten through the FIRST symbolic link found (that
 * link's target plus the remaining segments), or null when the walk crosses
 * no link.
 *
 * Per-segment, not leaf-only: a symlinked PARENT escapes the reach behind a
 * perfectly ordinary leaf. A missing segment is not a link — `lstat` finding
 * nothing is the normal case for a write to a file that does not exist yet,
 * and nothing can live below a segment that is absent, so the walk stops.
 * Only the portion BELOW the allowed prefix is walked: segments above it are
 * the operator's own layout (`/var` → `/private/var` on macOS), not an escape.
 *
 * Mirror of `followFirstSymlink` in `packages/storage-fs/src/scoped-storage.ts`.
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
    const linkTarget = normalize(resolve(dirname(cursor), readlinkSync(cursor)));
    return normalize(join(linkTarget, ...segments.slice(i + 1)));
  }
  return null;
}
