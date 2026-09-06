import { lstat, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { deriveDocumentsRoots } from '@ethosagent/core';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError, EthosError, type PersonalityConfig, type Storage } from '@ethosagent/types';
import { assertSafeTeamName } from './kanban.service';

// Documents service — the operator's only channel to the files the agent
// writes on a headless box.
//
// Containment is REUSED, not rewritten. Each browse root is one of the
// personality's declared `fs_reach.workdir` entries (via `deriveDocumentsRoots`
// — the multi-root derivation; see its doc comment for why this is NOT
// `deriveFsReachPaths`, which only ever returns the first entry), and every
// path the caller supplies is judged by the same `ScopedStorage` decorator the
// agent's own file tools are bounded by. There is no second hand-rolled prefix
// check here: `ScopedStorage.check()` calls `resolve()` before the prefix
// test, so `..` segments and absolute paths both land outside the allowlist
// and are rejected.
//
// A TEAM is the other thing a Documents call can address (`scope.team`
// instead of `scope.personalityId`). Its one root is the team's work
// directory, `<teamsDir>/<team>/` — the tree the members write into
// (brand/, opportunities/, state/, memory/, …). No `fs_reach` allowlist is
// consulted for it: the team directory IS the boundary, wrapped in the same
// `ScopedStorage` + symlink walk as a personality root. A team whose directory
// does not exist yet has no roots, exactly as an undeclared personality
// workdir has none.
//
// A personality with NO declared `fs_reach.workdir` has NO roots at all —
// Documents is unconfigured for it. There is deliberately no fallback to
// `process.cwd()`: that would silently root Documents at wherever the server
// process happened to be launched from, an implicit and unreviewed grant of
// filesystem access. Every method that operates against a specific root
// (`list`/`delete`/`resolveDownload`/`createFolder`/`write`, all via the
// private `resolve()`) throws `WORKDIR_NOT_CONFIGURED` in that case. `root()`
// itself is the one exception — see its doc comment.
//
// The one thing `ScopedStorage` CANNOT do is refuse symlinks: `Storage`
// follows them and has no `lstat`, so a symlink inside a root pointing at
// `~/.ssh/id_rsa` passes the prefix test on the LINK path and then reads the
// target. Every path is therefore walked segment-by-segment with a raw
// `lstat` and refused if any component is a symlink — the same rationale and
// the same carve-out as `extensions/gateway/src/media.ts` (W3.2 exfiltration
// guard). Walking every segment (not just the leaf, as media.ts does) matters
// here because the caller supplies multi-segment paths: `link/secret` has a
// non-symlink leaf but escapes through a symlinked parent.

/** One row in the Documents listing. `path` is relative to the selected root. */
export interface DocumentEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
  isSymlink: boolean;
}

/**
 * What the download route needs to stream a file it never resolved itself.
 * Content-Type is the route's business — it owns the MIME table.
 */
export interface DocumentDownload {
  absolutePath: string;
  filename: string;
  size: number;
}

/**
 * What a Documents call addresses: a personality's declared roots, or a team's
 * work directory. Neither set means the configured default personality; both
 * set is refused.
 */
export interface DocumentsScope {
  personalityId?: string | undefined;
  team?: string | undefined;
}

export interface DocumentsServiceOptions {
  personalities: FilePersonalityRegistry;
  /** `~/.ethos` — the `${ETHOS_HOME}` every declared root substitutes against. */
  dataDir: string;
  /** Inner Storage the per-request `ScopedStorage` decorates. */
  storage: Storage;
  /** Where team work directories live. Defaults to `<dataDir>/teams`. */
  teamsDir?: string;
  /**
   * Reload the personality registry from disk before a read, so a personality
   * whose `fs_reach.workdir` was just edited is honoured without a restart.
   * Matches the hot-reload convention of every other web-api service.
   */
  refresh?: () => Promise<void>;
}

export class DocumentsService {
  constructor(private readonly opts: DocumentsServiceOptions) {}

  /**
   * Every Documents root a personality declares. `id` is the entry's index
   * into `fs_reach.workdir` (stringified) — stable for the lifetime of a
   * personality's config, and the same value every other method's `root`
   * parameter expects back.
   *
   * Unlike every other method here, this does NOT throw `WORKDIR_NOT_CONFIGURED`
   * for a personality with no declared roots — it returns `{ roots: [] }`
   * instead. `root()` is a discovery call (the UI's root switcher / empty-state
   * check calls it to find out WHAT is configured), not an operation against a
   * root that must already exist, so "zero roots" is a valid answer rather
   * than an error.
   */
  async root(scope: DocumentsScope = {}): Promise<{
    roots: Array<{ id: string; path: string }>;
    personalityId?: string;
    team?: string;
  }> {
    const resolved = await this.rootsFor(scope);
    const roots = resolved.roots.map((workdir, index) => ({ id: String(index), path: workdir }));
    return resolved.kind === 'team'
      ? { roots, team: resolved.team }
      : { roots, personalityId: resolved.personalityId };
  }

  async list(
    input: DocumentsScope & {
      root: string;
      path?: string;
    },
  ): Promise<{ entries: DocumentEntry[] }> {
    const { workdir, scoped } = await this.resolve(input, input.root);
    const dir = await this.reachable(scoped, workdir, input.path);

    // `listEntries` yields [] for a missing directory, which is the right
    // answer for a root the agent has not written to yet.
    const entries = await guardBoundary(() => scoped.listEntries(dir));
    return {
      entries: await Promise.all(
        entries.map(async (e) => {
          const full = join(dir, e.name);
          const st = await lstat(full).catch(() => null);
          return {
            name: e.name,
            path: relative(workdir, full),
            isDir: e.isDir,
            ...(e.size !== undefined ? { size: e.size } : {}),
            ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}),
            isSymlink: st?.isSymbolicLink() ?? false,
          };
        }),
      ),
    };
  }

  /**
   * Hard delete of a single FILE. Directories are refused outright — see the
   * class note; a browser delete button that silently removes a subtree is the
   * surprising behaviour, and there is no trash tier to undo it from.
   */
  async delete(
    input: DocumentsScope & {
      root: string;
      path: string;
    },
  ): Promise<{ ok: true }> {
    const { workdir, scoped } = await this.resolve(input, input.root);
    const target = await this.reachable(scoped, workdir, input.path);
    if (target === resolve(workdir)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'The Documents root itself cannot be deleted.',
        action: 'Select a file inside the root.',
      });
    }

    const st = await lstat(target).catch(() => null);
    if (!st) throw notFound();
    if (st.isDirectory()) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Directories cannot be deleted from the Documents surface.',
        action: 'Delete the files inside it individually.',
      });
    }

    await guardBoundary(() => scoped.remove(target));
    return { ok: true };
  }

  /**
   * Validate a download and hand the route the metadata it needs. Bytes are
   * NOT read here — the route streams them, so a large artifact never lands in
   * the server's heap.
   */
  async resolveDownload(
    input: DocumentsScope & {
      root: string;
      path: string;
    },
  ): Promise<DocumentDownload> {
    const { workdir, scoped } = await this.resolve(input, input.root);
    const target = await this.reachable(scoped, workdir, input.path);

    const st = await lstat(target).catch(() => null);
    if (!st) throw notFound();
    if (!st.isFile()) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Only regular files can be downloaded.',
        action: 'Pick a file rather than a directory.',
      });
    }

    return { absolutePath: target, filename: basename(target), size: st.size };
  }

  /**
   * Create exactly one new directory under the selected root. Non-recursive
   * on purpose: the parent must already exist. `Storage.mkdir` is always
   * recursive (`{ recursive: true }`), so the explicit parent-exists check
   * below is what turns it into a non-recursive create in effect — with the
   * parent verified present, it can only ever create the one requested
   * directory. This keeps folder creation predictable: no silent creation of
   * a multi-level hierarchy from a typo'd path.
   */
  async createFolder(scope: DocumentsScope, root: string, path: string): Promise<DocumentEntry> {
    const { workdir, scoped } = await this.resolve(scope, root);
    const target = await this.reachable(scoped, workdir, path);

    const existing = await lstat(target).catch(() => null);
    if (existing) {
      throw new EthosError({
        code: 'DOCUMENT_EXISTS',
        cause: 'Something already exists at that path.',
        action: 'Pick a different folder name.',
      });
    }

    await this.requireParentDir(target);
    await guardBoundary(() => scoped.mkdir(target));

    return this.entryFor(workdir, target);
  }

  /**
   * Write `body` to `path` under the selected root. The parent directory must
   * already exist (no auto-`mkdir` of intermediate directories — see the
   * class note on `createFolder` for the same rationale) and, unless
   * `opts.overwrite` is `true`, an existing file at `path` is refused rather
   * than clobbered.
   *
   * `scoped.writeAtomic` already gives the write-temp-then-rename guarantee
   * this needs: it writes to `<path>.tmp.<pid>.<timestamp>` in the SAME
   * directory as `target`, then renames into place, so a failed or
   * interrupted write never leaves a partial file at the destination.
   */
  async write(
    scope: DocumentsScope,
    root: string,
    path: string,
    body: ReadableStream<Uint8Array> | Buffer,
    opts: { overwrite: boolean },
  ): Promise<DocumentEntry> {
    const { workdir, scoped } = await this.resolve(scope, root);
    const target = await this.reachable(scoped, workdir, path);

    await this.requireParentDir(target);

    const existing = await lstat(target).catch(() => null);
    if (existing?.isDirectory()) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'That path is a folder, not a file.',
        action: 'Pick a file path, or a different destination.',
      });
    }
    if (existing && !opts.overwrite) {
      throw new EthosError({
        code: 'DOCUMENT_EXISTS',
        cause: 'A file already exists at that path.',
        action: 'Retry with overwrite enabled, or pick a different filename.',
      });
    }

    const bytes = await readAllBytes(body);
    await guardBoundary(() => scoped.writeAtomic(target, bytes));

    return this.entryFor(workdir, target);
  }

  /**
   * Resolve the scope, then the caller-selected root's absolute directory and
   * the `ScopedStorage` that confines every subsequent operation to it.
   *
   * Throws `WORKDIR_NOT_CONFIGURED` when the scope has no roots at all (an
   * undeclared personality workdir, or a team directory that does not exist
   * yet), and `INVALID_INPUT` when `root` does not name one of them (a stale
   * id from before the personality's config changed, or a client bug). See
   * `root()` for the id scheme (stringified index).
   */
  private async resolve(
    scope: DocumentsScope,
    root: string,
  ): Promise<{ workdir: string; scoped: ScopedStorage }> {
    const resolved = await this.rootsFor(scope);
    if (resolved.roots.length === 0) {
      throw resolved.kind === 'team'
        ? new EthosError({
            code: 'WORKDIR_NOT_CONFIGURED',
            cause: `Team "${resolved.team}" has no work directory yet.`,
            action: 'It is created the first time the team runs.',
          })
        : new EthosError({
            code: 'WORKDIR_NOT_CONFIGURED',
            cause: `Personality "${resolved.personalityId}" has no declared \`fs_reach.workdir\`.`,
            action: "Set `fs_reach.workdir` in this personality's config.yaml.",
          });
    }

    const index = Number.parseInt(root, 10);
    const workdir = Number.isInteger(index) ? resolved.roots[index] : undefined;
    if (!workdir) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Unknown Documents root "${root}" for ${resolved.subject}.`,
        action: 'Call documents.root to list the declared roots and pick a valid id.',
      });
    }

    return {
      workdir,
      scoped: new ScopedStorage(this.opts.storage, {
        read: [workdir],
        write: [workdir],
        alwaysDeny: defaultAlwaysDeny(),
      }),
    };
  }

  /**
   * The absolute root directories a scope addresses, in `root` id order, plus
   * what to call the scope in an error message. A personality's are its
   * declared `fs_reach.workdir` entries; a team's is its single work
   * directory when that exists on disk, else none.
   */
  private async rootsFor(
    scope: DocumentsScope,
  ): Promise<
    | { kind: 'personality'; personalityId: string; roots: string[]; subject: string }
    | { kind: 'team'; team: string; roots: string[]; subject: string }
  > {
    if (scope.team !== undefined) {
      if (scope.personalityId !== undefined) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: 'A Documents call addresses a personality or a team, not both.',
          action: 'Pass either `personalityId` or `team`.',
        });
      }
      const team = scope.team;
      try {
        assertSafeTeamName(team);
      } catch {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: 'That is not a valid team name.',
          action: 'Pick a team from the Teams tab.',
        });
      }
      const dir = join(this.opts.teamsDir ?? join(this.opts.dataDir, 'teams'), team);
      const st = await stat(dir).catch(() => null);
      return {
        kind: 'team',
        team,
        roots: st?.isDirectory() ? [dir] : [],
        subject: `team "${team}"`,
      };
    }

    const personality = await this.getPersonality(scope.personalityId);
    return {
      kind: 'personality',
      personalityId: personality.id,
      roots: this.declaredRoots(personality).map((r) => r.workdir),
      subject: `personality "${personality.id}"`,
    };
  }

  /** Reload the registry, then look up the personality (or the default). */
  private async getPersonality(personalityId?: string): Promise<PersonalityConfig> {
    await this.opts.refresh?.();
    const registry = this.opts.personalities;
    // No id supplied → the configured default (`personality:` in config.yaml,
    // which wiring installs via `setDefault`).
    const personality = personalityId ? registry.get(personalityId) : registry.getDefault();
    if (!personality) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `No personality with id "${personalityId}".`,
        action: 'Pick one from the Personalities tab.',
      });
    }
    return personality;
  }

  /** Every root the personality's `fs_reach.workdir` declares, in order. */
  private declaredRoots(personality: PersonalityConfig): Array<{ label: string; workdir: string }> {
    return deriveDocumentsRoots(personality, {
      ethosHome: this.opts.dataDir,
      self: personality.id,
      cwd: process.cwd(),
    });
  }

  /**
   * Turn a caller-supplied relative path into an absolute one that is both
   * inside the scope and free of symlinks.
   *
   * `resolve(workdir, rel)` deliberately keeps an absolute `rel` as-is — that
   * lands outside the allowlist and `ScopedStorage` rejects it, which is the
   * intended answer for `path=/etc/passwd`.
   */
  private async reachable(
    scoped: ScopedStorage,
    workdir: string,
    relPath: string | undefined,
  ): Promise<string> {
    const target = resolve(workdir, relPath ?? '.');

    // Let ScopedStorage judge containment BEFORE any lstat touches the path.
    // `exists` runs the read check; read and write prefixes are the same single
    // root here, so a read pass is also a write pass. The real operation
    // re-checks through the same decorator — this call only orders the gate
    // ahead of the symlink walk.
    await guardBoundary(() => scoped.exists(target));

    const rel = relative(workdir, target);
    if (rel !== '') {
      let cursor = resolve(workdir);
      for (const segment of rel.split(sep)) {
        cursor = join(cursor, segment);
        const st = await lstat(cursor).catch(() => null);
        if (st?.isSymbolicLink()) {
          throw new EthosError({
            code: 'FORBIDDEN',
            cause: 'That path passes through a symbolic link.',
            action: 'Symlinks are not served — they can point outside the root.',
          });
        }
      }
    }
    return target;
  }

  /** Throws `FILE_NOT_FOUND` unless `target`'s parent directory already exists. */
  private async requireParentDir(target: string): Promise<void> {
    const parentStat = await lstat(dirname(target)).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new EthosError({
        code: 'FILE_NOT_FOUND',
        cause: 'The parent folder does not exist.',
        action: 'Create the parent folder first, or pick an existing destination.',
      });
    }
  }

  /** Build the `list()`-shaped entry for a path this service just created. */
  private async entryFor(workdir: string, target: string): Promise<DocumentEntry> {
    const st = await lstat(target);
    return {
      name: basename(target),
      path: relative(workdir, target),
      isDir: st.isDirectory(),
      ...(st.isFile() ? { size: st.size } : {}),
      mtimeMs: st.mtimeMs,
      isSymlink: st.isSymbolicLink(),
    };
  }
}

function notFound(): EthosError {
  return new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: 'No such file under this Documents root.',
    action: 'Refresh the listing — it may have been moved or deleted.',
  });
}

/**
 * Translate `ScopedStorage`'s `BoundaryError` into the web-api envelope. The
 * BoundaryError message carries the resolved ABSOLUTE path and the allowlist;
 * neither goes on the wire, so a caller probing the surface learns only that
 * the path was refused.
 */
async function guardBoundary<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof BoundaryError) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: 'That path is outside the Documents root.',
        action: 'Paths are relative to the Documents root.',
      });
    }
    throw err;
  }
}

/**
 * Collect a `ReadableStream<Uint8Array>` into one `Uint8Array`, or pass a
 * `Buffer` through unchanged (a `Buffer` already IS a `Uint8Array`). The route
 * layer decides whether it hands over an already-buffered, size-capped body or
 * a live stream; either way `Storage.writeAtomic` needs the bytes in hand,
 * since the `Storage` contract has no streaming write.
 */
async function readAllBytes(body: ReadableStream<Uint8Array> | Buffer): Promise<Uint8Array> {
  if (Buffer.isBuffer(body)) return body;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
