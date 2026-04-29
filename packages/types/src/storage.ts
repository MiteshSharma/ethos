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
}

export interface Storage {
  // --- Reads ----------------------------------------------------------

  /** Read a file as utf-8 text. Returns null if the file doesn't exist. */
  read(path: string): Promise<string | null>;

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
   * Write utf-8 text. Creates the file if missing; overwrites if present.
   * Parent directories must already exist (use mkdir first). The optional
   * `mode` sets POSIX file permissions atomically with the write.
   */
  write(path: string, content: string, opts?: StorageWriteOptions): Promise<void>;

  /**
   * Append utf-8 text. Creates the file if missing. Distinct from
   * `write` because batch / log writers (JSONL outputs, audit logs) need
   * O(1) append, not O(n) read-modify-write.
   */
  append(path: string, content: string): Promise<void>;

  /**
   * Atomic write: write to <path>.tmp.<pid>, then rename to <path>.
   * Used for files where partial writes corrupt state (config, keys, audit).
   * `mode` is applied to the temp file before rename, so the final file
   * always has the requested permissions from the moment it exists.
   */
  writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void>;

  /** Create a directory and parent directories. No-op if already exists as a directory. */
  mkdir(dir: string): Promise<void>;

  /** Remove a file or directory. opts.recursive enables rm -rf semantics. */
  remove(path: string, opts?: StorageRemoveOptions): Promise<void>;

  /** Rename / move a file or directory. */
  rename(from: string, to: string): Promise<void>;
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

  constructor(kind: 'read' | 'write', path: string, allowed: readonly string[]) {
    super(`${kind} not permitted: ${path} not in [${allowed.join(', ')}]`);
    this.name = 'BoundaryError';
    this.kind = kind;
    this.path = path;
  }
}
