import type { Storage } from '@ethosagent/types';

/**
 * A `Storage` backed by a Map, for the JSONL-backed stores this adapter keeps
 * (`ThreadStateStore`, and the shared `ChannelOverrideStore` from
 * `@ethosagent/core`). Shared so the suites that drive a REAL store — rather
 * than a structural stand-in that would need a cast past its private fields —
 * do not each carry their own copy.
 */
export function createInMemoryStorage(): Storage {
  const files = new Map<string, string>();
  return {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, content: string) => {
      files.set(path, content);
    },
    append: async (path: string, content: string) => {
      const existing = files.get(path) ?? '';
      files.set(path, existing + content);
    },
    exists: async (path: string) => files.has(path),
    mkdir: async () => {},
    mtime: async () => null,
    list: async () => [],
    listEntries: async () => [],
    writeAtomic: async (path: string, content: string) => {
      files.set(path, content);
    },
    readBytes: async () => null,
    remove: async (path: string) => {
      files.delete(path);
    },
    rename: async () => {},
    chmod: async () => {},
  };
}
