import { dirname } from 'node:path';
import type {
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';

interface FileNode {
  type: 'file';
  content: string;
  mode?: number;
  mtimeMs: number;
}

interface DirNode {
  type: 'dir';
  mtimeMs: number;
}

type Node = FileNode | DirNode;

/**
 * In-memory Storage implementation for tests. Mirrors fs semantics closely:
 *
 *  - read/exists/mtime return null for missing paths.
 *  - write requires the parent directory to exist (throws ENOENT otherwise) —
 *    matches fs.writeFile and forces tests to mkdir first, just like prod.
 *  - mkdir is always recursive; no-op on existing dirs; throws on file conflict.
 *  - remove without recursive throws on missing paths and on non-empty dirs.
 *  - writeAtomic round-trips through a temp key, identical to fs flow.
 *
 * mtime ticks forward on every write so cache-by-mtime patterns work in tests
 * without sleeping.
 */
export class InMemoryStorage implements Storage {
  // Absolute path → node
  private readonly nodes = new Map<string, Node>();
  private clock = 0;

  // Treat the filesystem root as always existing so consumers don't need to
  // mkdir('/') before writing to a file at the root.
  private isRootLike(path: string): boolean {
    return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path);
  }

  private nextMtime(): number {
    this.clock += 1;
    return this.clock;
  }

  private getNode(path: string): Node | undefined {
    return this.nodes.get(path);
  }

  private requireParentDir(path: string): void {
    const parent = dirname(path);
    if (parent === path) return;
    if (this.isRootLike(parent)) return;
    const node = this.nodes.get(parent);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    if (node.type !== 'dir') {
      const err = new Error(`ENOTDIR: not a directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOTDIR';
      throw err;
    }
  }

  async read(path: string): Promise<string | null> {
    const node = this.getNode(path);
    if (!node) return null;
    if (node.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      (err as NodeJS.ErrnoException).code = 'EISDIR';
      throw err;
    }
    return node.content;
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(path);
  }

  async mtime(path: string): Promise<number | null> {
    const node = this.getNode(path);
    return node ? node.mtimeMs : null;
  }

  async list(dir: string): Promise<string[]> {
    const node = this.getNode(dir);
    if (!node) return [];
    if (node.type !== 'dir') {
      const err = new Error(`ENOTDIR: not a directory, scandir '${dir}'`);
      (err as NodeJS.ErrnoException).code = 'ENOTDIR';
      throw err;
    }
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === dir) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      names.push(rest);
    }
    return names.sort();
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const names = await this.list(dir);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return names.map((name) => {
      const node = this.nodes.get(prefix + name);
      return { name, isDir: node?.type === 'dir' };
    });
  }

  async write(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    const existing = this.nodes.get(path);
    if (existing && existing.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
      (err as NodeJS.ErrnoException).code = 'EISDIR';
      throw err;
    }
    this.requireParentDir(path);
    const node: FileNode = {
      type: 'file',
      content,
      mtimeMs: this.nextMtime(),
    };
    if (opts?.mode !== undefined) node.mode = opts.mode;
    this.nodes.set(path, node);
  }

  async writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    // Same observable end-state as write — atomicity is a property of the
    // backing store; the in-memory map is single-step by definition.
    await this.write(path, content, opts);
  }

  async mkdir(dir: string): Promise<void> {
    if (this.isRootLike(dir)) return;
    const existing = this.nodes.get(dir);
    if (existing) {
      if (existing.type === 'dir') return;
      const err = new Error(`EEXIST: file already exists, mkdir '${dir}'`);
      (err as NodeJS.ErrnoException).code = 'EEXIST';
      throw err;
    }
    // Recursively create parents.
    const parent = dirname(dir);
    if (parent !== dir && !this.isRootLike(parent) && !this.nodes.has(parent)) {
      await this.mkdir(parent);
    }
    this.nodes.set(dir, { type: 'dir', mtimeMs: this.nextMtime() });
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    const node = this.nodes.get(path);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, remove '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    if (node.type === 'file') {
      this.nodes.delete(path);
      return;
    }
    // Directory.
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const children: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== path && key.startsWith(prefix)) children.push(key);
    }
    if (children.length > 0 && opts?.recursive !== true) {
      const err = new Error(`ENOTEMPTY: directory not empty, remove '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOTEMPTY';
      throw err;
    }
    for (const key of children) this.nodes.delete(key);
    this.nodes.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.nodes.get(from);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    this.requireParentDir(to);

    if (node.type === 'file') {
      const target = this.nodes.get(to);
      if (target?.type === 'dir') {
        const err = new Error(`EISDIR: cannot rename file onto directory, '${from}' -> '${to}'`);
        (err as NodeJS.ErrnoException).code = 'EISDIR';
        throw err;
      }
      this.nodes.delete(from);
      this.nodes.set(to, { ...node, mtimeMs: this.nextMtime() });
      return;
    }

    // Directory rename — move the directory itself plus every descendant.
    const targetExisting = this.nodes.get(to);
    if (targetExisting) {
      const err = new Error(`EEXIST: target exists, rename '${from}' -> '${to}'`);
      (err as NodeJS.ErrnoException).code = 'EEXIST';
      throw err;
    }
    const fromPrefix = from.endsWith('/') ? from : `${from}/`;
    const moves: Array<[string, string]> = [[from, to]];
    for (const key of this.nodes.keys()) {
      if (key !== from && key.startsWith(fromPrefix)) {
        moves.push([key, to + key.slice(from.length)]);
      }
    }
    for (const [src, dst] of moves) {
      const n = this.nodes.get(src);
      if (!n) continue;
      this.nodes.delete(src);
      this.nodes.set(dst, { ...n, mtimeMs: this.nextMtime() });
    }
  }

  // --- Test helpers -----------------------------------------------------

  /** Drop all state. Useful for `beforeEach` resets without re-instantiating. */
  reset(): void {
    this.nodes.clear();
    this.clock = 0;
  }

  /** Return the recorded mode for a file (undefined if no mode was set). */
  getMode(path: string): number | undefined {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') return undefined;
    return node.mode;
  }
}
