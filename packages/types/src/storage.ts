// @ethosagent/types — Storage interface
//
// Abstraction over filesystem operations under ~/.ethos/. Every consumer
// that reads or writes Ethos state takes a Storage in its constructor.
// Production wires FsStorage; tests wire InMemoryStorage; ScopedStorage
// decorates either with a per-personality path-allowlist.
//
// Path semantics: all paths are absolute. The interface does NOT manage a
// root — consumers compute absolute paths via ethosDir() (or analog) and
// pass them in. ScopedStorage enforces an allowlist by validating each
// absolute path against a configured set of allowed prefixes.
//
// Error semantics:
//   - read/exists/mtime return null when the target doesn't exist
//   - All other operations throw on failure
//   - ScopedStorage throws BoundaryError when a path is outside the allowlist

export interface StorageWriteOptions {
  /**
   * POSIX file permissions (e.g. 0o600) applied atomically with the write,
   * with no race window where the file is briefly created with the default
   * umask. POSIX-only — on Windows the underlying fs.writeFile semantics
   * apply (mode is partially honored).
   */
  mode?: number;
}

export interface StorageRemoveOptions {
  /** rm -rf semantics. Required to remove a non-empty directory. */
  recursive?: boolean;
}

export interface StorageDirEntry {
  name: string;
  isDir: boolean;

  /**
   * File size in bytes. Optional because it is never free: a directory
   * listing carries names and types, never sizes, so any backend that
   * reports one paid an extra per-entry stat (or an equivalent remote
   * HEAD) to get it. Backends with no stat semantics — InMemoryStorage,
   * object stores that return keys only — omit it rather than invent a
   * number. Omitted for directories as well: a directory's on-disk size
   * is its dirent block, not the size of what it contains, so reporting
   * it would mislead every consumer that asked.
   */
  size?: number;

  /**
   * Modification time in epoch-ms — the same units as `mtime()`, and
   * omitted under the same conditions as `size`: the backend has no such
   * concept, or the entry vanished between the listing and the stat.
   * Absent means "not known", never "the epoch"; consumers must not
   * coerce it to 0.
   */
  mtimeMs?: number;
}

export interface Storage {
  // --- Reads ----------------------------------------------------------

  /** Read a file as utf-8 text. Returns null if the file doesn't exist. */
  read(path: string): Promise<string | null>;

  /**
   * Read a file as raw bytes. Returns null if the file doesn't exist.
   * Distinct from `read` because UTF-8 decoding mangles binary payloads
   * (JPEG / PNG / PDF magic bytes are not valid UTF-8 — Node replaces them
   * with U+FFFD). Consumers reading attachments, images, or any non-text
   * blob MUST use this method. The reach / boundary semantics are the same
   * as `read`.
   */
  readBytes(path: string): Promise<Uint8Array | null>;

  /** True if the path exists (file or directory). */
  exists(path: string): Promise<boolean>;

  /** Modification time in epoch-ms. Returns null if the path doesn't exist. */
  mtime(path: string): Promise<number | null>;

  /** List immediate children of a directory. Empty array if the directory doesn't exist. */
  list(dir: string): Promise<string[]>;

  /** List immediate children with type info. Empty array if the directory doesn't exist. */
  listEntries(dir: string): Promise<StorageDirEntry[]>;

  // --- Writes ---------------------------------------------------------

  /**
   * Write file contents. Strings are written as utf-8 text; `Uint8Array`
   * is written as raw bytes (image / audio / binary blobs). Creates the
   * file if missing; overwrites if present. Parent directories must
   * already exist (use mkdir first). The optional `mode` sets POSIX
   * file permissions atomically with the write.
   */
  write(path: string, content: string | Uint8Array, opts?: StorageWriteOptions): Promise<void>;

  /**
   * Append utf-8 text. Creates the file if missing. Distinct from
   * `write` because batch / log writers (JSONL outputs, audit logs) need
   * O(1) append, not O(n) read-modify-write.
   */
  append(path: string, content: string): Promise<void>;

  /**
   * Atomic write: write to <path>.tmp.<pid>, then rename to <path>.
   * Strings are written as utf-8 text; `Uint8Array` as raw bytes — the
   * same contract as `write` but with the no-partial-corruption guarantee.
   * Used for files where partial writes corrupt state (config, keys,
   * audit, image outputs). `mode` is applied to the temp file before
   * rename, so the final file always has the requested permissions from
   * the moment it exists.
   */
  writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void>;

  /** Create a directory and parent directories. No-op if already exists as a directory. */
  mkdir(dir: string): Promise<void>;

  /** Remove a file or directory. opts.recursive enables rm -rf semantics. */
  remove(path: string, opts?: StorageRemoveOptions): Promise<void>;

  /** Rename / move a file or directory. */
  rename(from: string, to: string): Promise<void>;

  /**
   * POSIX file/directory permissions on an existing path. Used by callers
   * that need to *tighten* an existing path's mode (the common case: a
   * secrets directory inherits umask 022 on creation, then needs to be
   * locked down to 0o700 so directory listing doesn't leak which refs are
   * configured). Distinct from `writeAtomic`'s `mode` option because that
   * one applies during write; `chmod` operates on existing paths.
   *
   * Backends without a POSIX permission concept (in-memory, remote) are
   * no-ops. POSIX-only backends throw if the path does not exist.
   */
  chmod(path: string, mode: number): Promise<void>;
}

export interface AttachmentCache {
  write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string>;
  clear(sessionKey: string): Promise<void>;
  pruneOlderThan(olderThanMs: number): Promise<{ removedCount: number }>;
  resolveLocalPath(url: string): string;
}

/**
 * Thrown by ScopedStorage when a read or write targets a path outside the
 * configured allowlist. Consumers (e.g. tools-file) should translate this
 * into a user-facing tool error rather than letting it propagate.
 */
export class BoundaryError extends Error {
  readonly code = 'storage-boundary' as const;
  readonly kind: 'read' | 'write';
  readonly path: string;

  constructor(kind: 'read' | 'write', path: string, allowed: readonly string[], why?: string) {
    const suffix = why ? ` (${why})` : '';
    super(`${kind} not permitted: ${path} not in [${allowed.join(', ')}]${suffix}`);
    this.name = 'BoundaryError';
    this.kind = kind;
    this.path = path;
  }
}

export type StorageFactory = (ctx: {
  config: Record<string, unknown>;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}) => Storage | Promise<Storage>;

export interface StorageRegistry {
  register(name: string, factory: StorageFactory): void;
  unregister(name: string): void;
  resolve(
    name: string,
    ctx: {
      config: Record<string, unknown>;
      secrets: import('./secrets').SecretsResolver;
      logger: import('./logger').Logger;
    },
  ): Promise<Storage>;
  get(name: string): Storage | undefined;
  list(): string[];
}
