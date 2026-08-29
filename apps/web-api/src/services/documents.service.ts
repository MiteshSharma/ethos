import { lstat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { deriveFsReachPaths } from '@ethosagent/core';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError, EthosError, type PersonalityConfig, type Storage } from '@ethosagent/types';

// Documents service — the operator's only channel to the files the agent
// writes on a headless box.
//
// Containment is REUSED, not rewritten. The browse root is the personality's
// declared `fs_reach.workdir` (via the single `deriveFsReachPaths`
// derivation), and every path the caller supplies is judged by the same
// `ScopedStorage` decorator the agent's own file tools are bounded by. There
// is no second hand-rolled prefix check here: `ScopedStorage.check()` calls
// `resolve()` before the prefix test, so `..` segments and absolute paths both
// land outside the allowlist and are rejected.
//
// The one thing `ScopedStorage` CANNOT do is refuse symlinks: `Storage`
// follows them and has no `lstat`, so a symlink inside the workdir pointing at
// `~/.ssh/id_rsa` passes the prefix test on the LINK path and then reads the
// target. Every path is therefore walked segment-by-segment with a raw
// `lstat` and refused if any component is a symlink — the same rationale and
// the same carve-out as `extensions/gateway/src/media.ts` (W3.2 exfiltration
// guard). Walking every segment (not just the leaf, as media.ts does) matters
// here because the caller supplies multi-segment paths: `link/secret` has a
// non-symlink leaf but escapes through a symlinked parent.

/** One row in the Documents listing. `path` is relative to the workdir root. */
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

export interface DocumentsServiceOptions {
  personalities: FilePersonalityRegistry;
  /** `~/.ethos` — the `${ETHOS_HOME}` the workdir declaration substitutes against. */
  dataDir: string;
  /** Inner Storage the per-request `ScopedStorage` decorates. */
  storage: Storage;
  /**
   * Reload the personality registry from disk before a read, so a personality
   * whose `fs_reach.workdir` was just edited is honoured without a restart.
   * Matches the hot-reload convention of every other web-api service.
   */
  refresh?: () => Promise<void>;
}

export class DocumentsService {
  constructor(private readonly opts: DocumentsServiceOptions) {}

  /** The absolute workdir a Documents view is rooted at. */
  async root(personalityId?: string): Promise<{ root: string; personalityId: string }> {
    const { personality, root } = await this.resolve(personalityId);
    return { root, personalityId: personality.id };
  }

  async list(input: {
    personalityId?: string;
    path?: string;
  }): Promise<{ entries: DocumentEntry[] }> {
    const { root, scoped } = await this.resolve(input.personalityId);
    const dir = await this.reachable(scoped, root, input.path);

    // `listEntries` yields [] for a missing directory, which is the right
    // answer for a workdir the agent has not written to yet.
    const entries = await guardBoundary(() => scoped.listEntries(dir));
    return {
      entries: await Promise.all(
        entries.map(async (e) => {
          const full = join(dir, e.name);
          const st = await lstat(full).catch(() => null);
          return {
            name: e.name,
            path: relative(root, full),
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
  async delete(input: { personalityId?: string; path: string }): Promise<{ ok: true }> {
    const { root, scoped } = await this.resolve(input.personalityId);
    const target = await this.reachable(scoped, root, input.path);
    if (target === resolve(root)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'The Documents root itself cannot be deleted.',
        action: 'Select a file inside the workdir.',
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
  async resolveDownload(input: {
    personalityId?: string;
    path: string;
  }): Promise<DocumentDownload> {
    const { root, scoped } = await this.resolve(input.personalityId);
    const target = await this.reachable(scoped, root, input.path);

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
   * Resolve the personality, its workdir root, and the `ScopedStorage` that
   * confines every subsequent operation to that root.
   */
  private async resolve(
    personalityId?: string,
  ): Promise<{ personality: PersonalityConfig; root: string; scoped: ScopedStorage }> {
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

    const { workdir } = deriveFsReachPaths(personality, {
      ethosHome: this.opts.dataDir,
      self: personality.id,
      cwd: process.cwd(),
    });

    return {
      personality,
      root: workdir,
      scoped: new ScopedStorage(this.opts.storage, {
        read: [workdir],
        write: [workdir],
        alwaysDeny: defaultAlwaysDeny(),
      }),
    };
  }

  /**
   * Turn a caller-supplied relative path into an absolute one that is both
   * inside the scope and free of symlinks.
   *
   * `resolve(root, rel)` deliberately keeps an absolute `rel` as-is — that
   * lands outside the allowlist and `ScopedStorage` rejects it, which is the
   * intended answer for `path=/etc/passwd`.
   */
  private async reachable(
    scoped: ScopedStorage,
    root: string,
    relPath: string | undefined,
  ): Promise<string> {
    const target = resolve(root, relPath ?? '.');

    // Let ScopedStorage judge containment BEFORE any lstat touches the path.
    // `exists` runs the read check; read and write prefixes are the same single
    // root here, so a read pass is also a write pass. The real operation
    // re-checks through the same decorator — this call only orders the gate
    // ahead of the symlink walk.
    await guardBoundary(() => scoped.exists(target));

    const rel = relative(root, target);
    if (rel !== '') {
      let cursor = resolve(root);
      for (const segment of rel.split(sep)) {
        cursor = join(cursor, segment);
        const st = await lstat(cursor).catch(() => null);
        if (st?.isSymbolicLink()) {
          throw new EthosError({
            code: 'FORBIDDEN',
            cause: 'That path passes through a symbolic link.',
            action: 'Symlinks are not served — they can point outside the workdir.',
          });
        }
      }
    }
    return target;
  }
}

function notFound(): EthosError {
  return new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: 'No such file in this workdir.',
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
        cause: 'That path is outside this personality’s workdir.',
        action: 'Paths are relative to the Documents root.',
      });
    }
    throw err;
  }
}
