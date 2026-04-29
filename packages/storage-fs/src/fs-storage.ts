import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async write(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    if (opts?.mode !== undefined) {
      await writeFile(path, content, { encoding: 'utf-8', mode: opts.mode });
      return;
    }
    await writeFile(path, content, 'utf-8');
  }

  async append(path: string, content: string): Promise<void> {
    await appendFile(path, content, 'utf-8');
  }

  async writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    if (opts?.mode !== undefined) {
      await writeFile(tmp, content, { encoding: 'utf-8', mode: opts.mode });
    } else {
      await writeFile(tmp, content, 'utf-8');
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
}
