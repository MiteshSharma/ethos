import type { BackupOptions, DatabaseSync as DatabaseSyncClass } from 'node:sqlite';

// `node:sqlite` is a Node built-in. Resolve it via `process.getBuiltinModule`
// instead of a static `import ... from 'node:sqlite'` so the bundler cannot
// strip the `node:` prefix: esbuild rewrote it to a bare `sqlite` specifier in
// the published CLI bundle, breaking `ethos serve` with ERR_MODULE_NOT_FOUND.
// The `import type` above is erased at build time, so no runtime import remains.
const { DatabaseSync, backup: nodeBackup } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncClass;

type RunResult = { changes: number; lastInsertRowid: number };

// biome-ignore lint/suspicious/noExplicitAny: type guard for named params objects
function isNamedParams(arg: any): arg is Record<string, unknown> {
  return (
    arg !== null &&
    arg !== undefined &&
    typeof arg === 'object' &&
    !Array.isArray(arg) &&
    !(arg instanceof Uint8Array) &&
    !(arg instanceof Buffer)
  );
}

class Statement {
  // biome-ignore lint/suspicious/noExplicitAny: wraps node:sqlite's variadic params
  private inner: any;

  // biome-ignore lint/suspicious/noExplicitAny: wraps node:sqlite's variadic params
  constructor(inner: any) {
    this.inner = inner;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  run(...params: any[]): RunResult {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.run(params[0])
        : this.inner.run(...params);
    return {
      changes: Number(r.changes),
      lastInsertRowid: Number(r.lastInsertRowid),
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  get(...params: any[]): any {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.get(params[0])
        : this.inner.get(...params);
    return r;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  all(...params: any[]): any[] {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.all(params[0])
        : this.inner.all(...params);
    return r;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  *iterate(...params: any[]): Generator<any> {
    const rows = this.all(...params);
    for (const row of rows) {
      yield row;
    }
  }
}

class _Database {
  // biome-ignore lint/suspicious/noExplicitAny: namespace merge for Database.Database type compat
  static Database: any = _Database;

  private inner: DatabaseSync;
  private _txDepth = 0;
  private _closed = false;

  constructor(path: string, opts?: { readonly?: boolean }) {
    this.inner = new DatabaseSync(path, {
      readOnly: opts?.readonly ?? false,
    });
  }

  prepare(sql: string): Statement {
    return new Statement(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.inner.close();
  }

  pragma(str: string, _opts?: Record<string, unknown>): unknown {
    if (str.includes('=')) {
      this.inner.exec(`PRAGMA ${str}`);
      return undefined;
    }
    return this.prepare(`PRAGMA ${str}`).all();
  }

  // biome-ignore lint/suspicious/noExplicitAny: must accept any function signature for better-sqlite3 compat
  transaction<T extends (...args: any[]) => any>(
    fn: T,
  ): T & { deferred: T; immediate: T; exclusive: T } {
    const self = this;
    const makeWrapper = (beginCmd: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: wrapper must match any function signature
      const wrapper = function (this: any, ...args: any[]) {
        if (self._txDepth === 0) {
          self._txDepth++;
          self.inner.exec(beginCmd);
          try {
            const result = fn.apply(this, args);
            self.inner.exec('COMMIT');
            return result;
          } catch (err) {
            self.inner.exec('ROLLBACK');
            throw err;
          } finally {
            self._txDepth--;
          }
        } else {
          const sp = `sp_${self._txDepth}`;
          self._txDepth++;
          self.inner.exec(`SAVEPOINT ${sp}`);
          try {
            const result = fn.apply(this, args);
            self.inner.exec(`RELEASE ${sp}`);
            return result;
          } catch (err) {
            self.inner.exec(`ROLLBACK TO ${sp}`);
            self.inner.exec(`RELEASE ${sp}`);
            throw err;
          } finally {
            self._txDepth--;
          }
        }
      } as unknown as T;
      return wrapper;
    };

    const defaultWrapper = makeWrapper('BEGIN') as T & { deferred: T; immediate: T; exclusive: T };
    defaultWrapper.deferred = makeWrapper('BEGIN DEFERRED') as T;
    defaultWrapper.immediate = makeWrapper('BEGIN IMMEDIATE') as T;
    defaultWrapper.exclusive = makeWrapper('BEGIN EXCLUSIVE') as T;
    return defaultWrapper;
  }
}

namespace _Database {
  export type Database = _Database;
}

/**
 * Copy an open database to `destPath` via SQLite's online backup API.
 *
 * The one ASYNCHRONOUS member of an otherwise synchronous shim, deliberately:
 * in-process callers (the scheduled backup task, the web RPC) run inside a
 * serving process, where a synchronous `VACUUM INTO` over a multi-hundred-MB
 * database would stall the event loop for the whole copy. The source database
 * stays usable throughout, and the copy is consistent in WAL mode without a
 * checkpoint — which a plain file copy is not.
 *
 * Resolves with the number of pages transferred. `@types/node` declares the
 * return as `Promise<void>`, but Node 24 resolves the page count (as its own
 * documentation shows), hence the cast.
 */
export function backup(db: _Database, destPath: string, options?: BackupOptions): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: reads the wrapped node:sqlite handle without widening the public Database surface
  const source = (db as any).inner as DatabaseSync;
  // Node rejects an explicit `undefined` third argument ("options must be an
  // object"), so an absent `options` becomes `{}` and the platform defaults apply.
  return nodeBackup(source, destPath, options ?? {}) as unknown as Promise<number>;
}

export default _Database;
export type { BackupOptions, BackupProgressInfo } from 'node:sqlite';
export { type MigrationConfig, migrate } from './migrate';
export type { _Database as Database };
