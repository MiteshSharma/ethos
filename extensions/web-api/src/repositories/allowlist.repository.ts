import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
// Writes are atomic (tmp + rename) so a crash mid-write leaves the previous
// file intact (CEO finding 2.1, "Concurrent write to allowlist.json").

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
}

export class AllowlistRepository {
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: AllowlistRepositoryOptions) {
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
      await this.writeAtomic(file);
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
    try {
      const raw = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  private async writeAtomic(file: FileShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    await rename(tmp, this.path);
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
