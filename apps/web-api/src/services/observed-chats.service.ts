import { join } from 'node:path';
import {
  DEFAULT_READ_LIMIT,
  SQLiteChannelTranscriptStore,
} from '@ethosagent/channel-transcript-sqlite';
import type { ChannelTranscriptStore, Storage } from '@ethosagent/types';

// Read-only window onto the observe-mode transcript
// (plan/phases/ambient-group-monitoring.md R12).
//
// The gateway writes `<dataDir>/channel-transcript.db`; this service only ever
// reads lane SUMMARIES out of it — never message text. What a room said is the
// digest turn's input, not a settings page's content (§8, "Never the last
// message text"), and `listLanes` is the one store method that cannot return
// any.
//
// Two processes on one SQLite file is why the store sets WAL + `busy_timeout`;
// nothing extra is needed here. Same lazy-open rule as the delivery ledger and
// the call log beside it: opening the store CREATES and migrates the file, so a
// deployment whose gateway has never run must not grow a database because
// someone opened the Communications page.

export interface ObservedLaneRow {
  laneKey: string;
  platform: string;
  botKey: string;
  chatId: string;
  threadId: string | null;
  count: number;
  lastSentAt: number;
}

export interface ObservedChatsSummary {
  lanes: ObservedLaneRow[];
  /** Watched lanes past `limit`, said out loud rather than dropped in silence. */
  omittedCount: number;
  /** Why the read failed, when it did. See the contract's `error` field. */
  error: string | null;
}

export interface ObservedChatsQuery {
  /** Window for `count`, epoch ms. Omitted → all time. */
  since?: number;
  limit?: number;
}

export interface ObservedChatsServiceOptions {
  /** Ethos home directory — the transcript sits at `<dataDir>/channel-transcript.db`. */
  dataDir: string;
  /** Used ONLY to answer "does the transcript file exist yet". */
  storage: Storage;
  /**
   * Open a store at `path`. Seam for tests; production is the SQLite one.
   * Called at most once per process (see {@link ObservedChatsService.open}).
   */
  openStore?: (path: string) => ChannelTranscriptStore;
}

export class ObservedChatsService {
  private readonly path: string;
  private store: ChannelTranscriptStore | null = null;

  constructor(private readonly opts: ObservedChatsServiceOptions) {
    this.path = join(opts.dataDir, 'channel-transcript.db');
  }

  async observed(query: ObservedChatsQuery = {}): Promise<ObservedChatsSummary> {
    const limit = query.limit ?? DEFAULT_READ_LIMIT;
    let lanes: ObservedLaneRow[];
    let total: number;
    try {
      const store = await this.open();
      // Nothing has ever been observed here. An empty house is not an error,
      // and it is not a truncation either.
      if (!store) return { lanes: [], omittedCount: 0, error: null };
      const all = await store.listLanes(query.since === undefined ? {} : { since: query.since });
      total = all.length;
      // `listLanes` is newest-active first, so the head is the freshest —
      // a list that has to drop something drops the stale end, exactly as
      // `readSince` does with messages.
      lanes = all.slice(0, limit).map((lane) => ({
        laneKey: lane.laneKey,
        platform: lane.platform,
        botKey: lane.botKey,
        chatId: lane.chatId,
        threadId: lane.threadId ?? null,
        count: lane.count,
        lastSentAt: lane.lastSentAt,
      }));
    } catch (err) {
      // A corrupt or locked database is a `✗ failed` ROW on the page, not a
      // rejected RPC the client renders as a vanishing toast (contract §6).
      // The operator is told the transcript is unreadable and the row stays
      // there saying so.
      return {
        lanes: [],
        omittedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { lanes, omittedCount: Math.max(total - lanes.length, 0), error: null };
  }

  /**
   * The store handle, or null while the file does not exist.
   *
   * Constructed lazily and kept: the gateway holds the same file open, and
   * re-opening a WAL database on every request would churn -wal/-shm handles
   * for nothing. Once opened it is never re-probed — a file cannot un-exist
   * under a live handle, and the probe is only there to avoid creating one.
   */
  private async open(): Promise<ChannelTranscriptStore | null> {
    const existing = this.store;
    if (existing) return existing;
    if (!(await this.opts.storage.exists(this.path))) return null;
    const opened = (this.opts.openStore ?? ((p: string) => new SQLiteChannelTranscriptStore(p)))(
      this.path,
    );
    this.store = opened;
    return opened;
  }
}
