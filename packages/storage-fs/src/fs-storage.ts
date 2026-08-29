import { type Dirent, existsSync as fsExistsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';

export class FsStorage implements Storage {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      // No encoding → readFile returns a Buffer (which is a Uint8Array).
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async mtime(path: string): Promise<number | null> {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // readdir yields names and types but never sizes, so size/mtimeMs cost
    // one stat per file. Directories are skipped — their size is not a
    // meaningful number (see StorageDirEntry) — which leaves the
    // directory-walking callers (plugin loader, skills catalog, personality
    // loader) at exactly zero extra syscalls. The stats are issued together
    // so the file case costs one batched round, not N serialized waits.
    return await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return { name: e.name, isDir: true };
        try {
          const s = await stat(join(dir, e.name));
          return { name: e.name, isDir: false, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          // A broken symlink or a file deleted mid-listing costs that entry
          // its metadata, never the caller its whole listing.
          return { name: e.name, isDir: false };
        }
      }),
    );
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    const isBinary = typeof content !== 'string';
    if (opts?.mode !== undefined) {
      await writeFile(
        path,
        content,
        isBinary ? { mode: opts.mode } : { encoding: 'utf-8', mode: opts.mode },
      );
      return;
    }
    await writeFile(path, content, isBinary ? undefined : 'utf-8');
  }

  async append(path: string, content: string): Promise<void> {
    // Asymmetry with InMemoryStorage.append: InMemoryStorage throws
    // EINVAL when appending to a binary node, but FsStorage cannot
    // detect that here without an extra stat + first-byte read. If the
    // file on disk is binary, this silently concatenates utf-8 bytes
    // and produces a malformed file. Callers writing binary content
    // must use writeAtomic, not append.
    await appendFile(path, content, 'utf-8');
  }

  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    const isBinary = typeof content !== 'string';
    if (opts?.mode !== undefined) {
      await writeFile(
        tmp,
        content,
        isBinary ? { mode: opts.mode } : { encoding: 'utf-8', mode: opts.mode },
      );
    } else {
      await writeFile(tmp, content, isBinary ? undefined : 'utf-8');
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      // Best-effort cleanup of temp file on rename failure.
      try {
        await rm(tmp, { force: true });
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async mkdir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    await rm(path, { recursive: opts?.recursive === true });
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  /** Synchronous existence check. Not on the Storage interface (which is
   *  async-only). Added for `PluginApiImpl.hasSecret`, which no longer needs
   *  it — plugin credentials live in the SecretsResolver and `hasSecret`
   *  answers from a primed key set. Kept for external callers of this
   *  concrete class; nothing in the repo depends on it. */
  existsSync(path: string): boolean {
    return fsExistsSync(path);
  }
}
