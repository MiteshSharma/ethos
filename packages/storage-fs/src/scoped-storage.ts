import {
  BoundaryError,
  type Storage,
  type StorageDirEntry,
  type StorageRemoveOptions,
  type StorageWriteOptions,
} from '@ethosagent/types';

export interface ScopedStorageScope {
  /** Absolute path prefixes that may be read. */
  read: readonly string[];
  /** Absolute path prefixes that may be written / mutated. */
  write: readonly string[];
}

/**
 * Decorator over Storage that enforces a per-scope read/write allowlist.
 * Used by tools-file to bound a personality's filesystem reach to its own
 * directory + cwd (Phase 4 of the storage abstraction plan).
 *
 * A path is permitted if any allowed prefix is a prefix of the absolute path.
 * Prefixes are matched literally — there is no glob expansion. Pass paths
 * that end in `/` for directory scopes; ScopedStorage normalizes them so
 * `/a/b` does not also match `/a/bc/`.
 */
export class ScopedStorage implements Storage {
  private readonly readPrefixes: string[];
  private readonly writePrefixes: string[];

  constructor(
    private readonly inner: Storage,
    scope: ScopedStorageScope,
  ) {
    this.readPrefixes = scope.read.map(normalizePrefix);
    this.writePrefixes = scope.write.map(normalizePrefix);
  }

  private check(path: string, kind: 'read' | 'write'): void {
    const allowed = kind === 'read' ? this.readPrefixes : this.writePrefixes;
    if (!isPathAllowed(path, allowed)) {
      throw new BoundaryError(kind, path, allowed);
    }
  }

  async read(path: string): Promise<string | null> {
    this.check(path, 'read');
    return this.inner.read(path);
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

  async write(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    this.check(path, 'write');
    return this.inner.write(path, content, opts);
  }

  async append(path: string, content: string): Promise<void> {
    this.check(path, 'write');
    return this.inner.append(path, content);
  }

  async writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
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
}

function normalizePrefix(prefix: string): string {
  // A prefix matches any path where prefix is followed by '/' or end-of-string,
  // OR where the path equals the prefix exactly. We keep the prefix as-given
  // (with or without trailing slash) and handle the boundary in isPathAllowed.
  return prefix;
}

function isPathAllowed(path: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (path === prefix) return true;
    const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (path.startsWith(withSlash)) return true;
  }
  return false;
}
