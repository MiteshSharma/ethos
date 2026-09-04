import { EthosError } from '@ethosagent/types';
import type Database from './index';

// ---------------------------------------------------------------------------
// Forward-only `user_version` migration harness.
//
// Generalized from kanban-store's inline constructor logic so every SQLite
// store shares one blueprint: a downgrade guard, an idempotent baseline, and a
// stepwise migration chain that bumps `user_version` atomically. This is also
// the reference shape for a future Postgres harness.
//
// Deliberately NOT handled here: WAL / foreign_keys PRAGMAs. The caller opens
// the DB and sets its own journal/foreign-key mode BEFORE calling `migrate`, so
// the downgrade guard reads a properly-opened DB. `migrate` is purely about
// versioning + baseline + the migration chain.
// ---------------------------------------------------------------------------

export interface MigrationConfig {
  /** Store name for error messages, e.g. 'session-sqlite'. */
  name: string;
  /** The version this code expects (>= 1). */
  targetVersion: number;
  /** Full current schema as `CREATE ... IF NOT EXISTS` (idempotent). */
  baseline: string;
  /** Step `N` brings a `(N-1)` DB to `N`. Omit steps that need no DDL. */
  migrations?: Record<number, (db: Database.Database) => void>;
}

/**
 * Bring `db` up to `config.targetVersion`.
 *
 * 1. Read `user_version`. If it is GREATER than the target, throw — refuse to
 *    open a DB whose schema is newer than this code (downgrade guard).
 * 2. `exec(baseline)` always. It is idempotent (`IF NOT EXISTS`), so it brings
 *    a fresh DB to the current table shape and is a no-op on existing tables.
 * 3. If the DB is fresh (`user_version === 0`), stamp it to the target.
 * 4. Otherwise walk `current+1 .. targetVersion`, running each step's migration
 *    function (if any) and its version bump inside a single transaction so a
 *    failed step rolls back atomically.
 */
export function migrate(db: Database.Database, config: MigrationConfig): void {
  const { name, targetVersion, baseline, migrations } = config;

  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  const current = rows[0]?.user_version ?? 0;

  if (current > targetVersion) {
    throw new EthosError({
      code: 'IMPORT_NEWER_SCHEMA',
      cause: `${name}: database user_version=${current} is newer than code (${targetVersion}); refusing to open to avoid downgrade`,
      action: 'Upgrade Ethos to a build that understands this schema, then retry.',
      details: { store: name, databaseVersion: current, codeVersion: targetVersion },
    });
  }

  db.exec(baseline);

  if (current === 0) {
    db.pragma(`user_version = ${targetVersion}`);
    return;
  }

  for (let v = current + 1; v <= targetVersion; v++) {
    const step = migrations?.[v];
    // Migration DDL + version bump move together: a rollback leaves the DB at
    // its prior version, never a half-migrated shape stamped with the new one.
    db.transaction(() => {
      if (step) step(db);
      db.pragma(`user_version = ${v}`);
    })();
  }
}
