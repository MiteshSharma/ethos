// Consistent SQLite snapshots for a backup (plan D2).
//
// A WAL database's committed data lives in two files: the main database and an
// uncheckpointed `-wal`. Copying only the main file therefore loses every
// commit since the last checkpoint — with `wal_autocheckpoint = 0` that is the
// entire database, including the schema. `snapshot.test.ts` shows exactly that.
//
// Two modes, and the difference is which thread pays:
//
//   'backup'  SQLite's online backup API via `@ethosagent/sqlite`'s async
//             `backup()`. MANDATORY for in-process callers — the scheduled
//             task and the web RPC run inside a serving process, where a
//             synchronous copy of a multi-hundred-MB database stalls the event
//             loop for its whole duration.
//   'vacuum'  `VACUUM INTO`. Synchronous and compacting; for the CLI, which
//             has nothing else to serve.
//
// Both open their own read-only connection, so a live process holding the
// database keeps working throughout.
//
// Raw path handling is the documented `@ethosagent/sqlite` carve-out
// (AGENTS.md): the shim opens files, not `Storage` handles.

import Database, { backup } from '@ethosagent/sqlite';

export type SnapshotMode = 'backup' | 'vacuum';

/**
 * Copy the database at `srcPath` to `destPath`, folding in any uncheckpointed
 * WAL. `destPath` must not already exist.
 */
export async function snapshotSqlite(
  srcPath: string,
  destPath: string,
  mode: SnapshotMode,
): Promise<void> {
  const db = new Database(srcPath, { readonly: true });
  try {
    if (mode === 'backup') {
      await backup(db, destPath);
    } else {
      // No parameter binding in VACUUM INTO; SQLite string literals escape a
      // quote by doubling it.
      db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
    }
  } finally {
    db.close();
  }
}
