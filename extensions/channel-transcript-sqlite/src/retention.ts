import { existsSync } from 'node:fs';
import Database from '@ethosagent/sqlite';

/**
 * Drop transcript rows past their retention window (R4).
 *
 * Called from the unconditional `observability-prune` system job, not from the
 * digest task: pruning has to happen on a deployment that records but has
 * never run a digest, and it has to happen whether or not observability is
 * enabled.
 *
 * @param dbPath        the transcript database. A path that does not exist is
 *                      a no-op — a deployment with observe mode switched off
 *                      never creates this file, and a prune that CREATED it
 *                      would leave an empty database behind on every machine.
 * @param retentionMs   window in milliseconds, or `null` for "forever" (what
 *                      `parseDuration('forever')` returns). Callers parse the
 *                      duration string; this module takes the number, so it
 *                      does not depend on the observability package for a
 *                      parser.
 * @returns rows deleted.
 */
export function pruneChannelTranscript(
  dbPath: string,
  retentionMs: number | null,
  opts: { now?: number } = {},
): number {
  if (retentionMs === null) return 0;
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return 0;

  const now = opts.now ?? Date.now();
  const db = new Database(dbPath);
  try {
    // The same house value the store's own connection sets, and this side
    // needs it just as much. In a split deployment `ethos serve` and `ethos
    // gateway` BOTH register the `observability-prune` system job, so this
    // DELETE can land while the peer process is mid-`record()` on the inbound
    // path. With no busy timeout SQLite gives up on the first conflict,
    // `database is locked` comes out of the cron handler, and nothing ages
    // out — a retention window that silently stops being honoured. Waiting is
    // the right side to be on: an inbound insert holds the write lock for a
    // single commit, and this is a background job.
    db.pragma('busy_timeout = 5000');

    // `recorded_at`, not `sent_at`: retention is a promise about how long we
    // KEEP something, and a message backdated by a platform (or by a sender
    // choosing its timestamp) must not be able to age itself out early or
    // linger past the window.
    //
    // ONE statement, deliberately. Deleting in batches was measured and
    // rejected: it does not bound the peer's wait (SQLite's busy handler backs
    // off to 100ms sleeps, and a pruner that re-takes the lock immediately
    // starves the waiter across batch after batch — worst inbound stall over a
    // 1.2M-row backlog fell only 4742ms → 2656ms) while making the prune's own
    // synchronous run 53% longer, which is event-loop time in whichever
    // process holds the cron. See the note in `index.ts` on `busy_timeout`.
    const result = db
      .prepare('DELETE FROM transcript WHERE recorded_at < ?')
      .run(now - retentionMs);
    return Number(result.changes);
  } finally {
    db.close();
  }
}
