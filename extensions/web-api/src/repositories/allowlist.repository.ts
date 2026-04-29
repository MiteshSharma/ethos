import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';

// `<dataDir>/allowlist.json` — persistent record of "always allow" decisions
// the user made through the web approval modal. Keeps the modal from firing
// for the same tool/args next turn.
//
// Two scope kinds round-trip through this store:
//   • `any-args`   → match any invocation of `toolName`
//   • `exact-args` → match `toolName` with the same canonical arg payload
//
// `once` is intentionally NOT persisted — it grants a single invocation and
// dies with the in-memory pending approval.
//
// Writes go through Storage.writeAtomic so a crash mid-write leaves the
// previous file intact (CEO finding 2.1, "Concurrent write to allowlist.json").

export type AllowlistScope = 'exact-args' | 'any-args';

export interface AllowlistEntry {
  toolName: string;
  scope: AllowlistScope;
  /** JSON-serialisable args payload. Required when `scope === 'exact-args'`,
   *  null otherwise. */
  args: unknown;
  /** ISO-8601 timestamp written at insert time. */
  createdAt: string;
}

interface FileShape {
  entries: AllowlistEntry[];
}

export interface AllowlistRepositoryOptions {
  /** Where `~/.ethos` lives. The file is `<dataDir>/allowlist.json`. */
  dataDir: string;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

export class AllowlistRepository {
  private readonly storage: Storage;
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: AllowlistRepositoryOptions) {
    this.storage = opts.storage ?? new FsStorage();
    this.path = join(opts.dataDir, 'allowlist.json');
  }

  async list(): Promise<AllowlistEntry[]> {
    const file = await this.readSafe();
    return file.entries;
  }

  /**
   * Append a new entry. Concurrent calls serialise through `writeChain` so
   * two `add()` calls never trample one another's snapshot.
   */
  async add(entry: Omit<AllowlistEntry, 'createdAt'>): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const file = await this.readSafe();
      file.entries.push({ ...entry, createdAt: new Date().toISOString() });
      await this.persist(file);
    });
    await this.writeChain;
  }

  /** True when `toolName`+`args` are covered by an existing entry. */
  async matches(toolName: string, args: unknown): Promise<boolean> {
    const file = await this.readSafe();
    const argsKey = canonicalKey(args);
    for (const entry of file.entries) {
      if (entry.toolName !== toolName) continue;
      if (entry.scope === 'any-args') return true;
      if (entry.scope === 'exact-args' && canonicalKey(entry.args) === argsKey) return true;
    }
    return false;
  }

  private async readSafe(): Promise<FileShape> {
    const raw = await this.storage.read(this.path);
    if (!raw) return { entries: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  private async persist(file: FileShape): Promise<void> {
    await this.storage.mkdir(dirname(this.path));
    await this.storage.writeAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

/**
 * Stable JSON serialisation: sort object keys recursively. Two args that
 * differ only in key ordering produce the same string, so an `exact-args`
 * allowlist match doesn't miss when the LLM reorders args between turns.
 */
function canonicalKey(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
