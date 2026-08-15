import { join } from 'node:path';
import {
  type CallDirection,
  type CallLog,
  type CallRecord,
  type CallStatus,
  MAX_RECENT_CALLS,
  SQLiteCallLog,
} from '@ethosagent/call-log';
import type { Storage } from '@ethosagent/types';

// Read-only window onto the durable telephony call log.
//
// The gateway writes the log; this service only reads it, from the SAME file
// (`<dataDir>/calls.db`) the gateway opens. Two processes on one SQLite file is
// why the log sets WAL + `busy_timeout`; nothing extra is needed here.
//
// Coded against the `CallLog` INTERFACE, not `SQLiteCallLog`: tests inject an
// `InMemoryCallLog` and get the same ordering and clamping guarantees without a
// file on disk.
//
// The log is a raw-path SQLite store, one of the documented `node:fs` carve-outs
// (see CLAUDE.md, Storage abstraction). `Storage` is still used — for the
// existence probe below, which is a plain read decision and belongs on the
// abstraction.

/** Truncation width for `summaryPreview` on the wire. See the RPC schema. */
const SUMMARY_PREVIEW_CHARS = 200;

/** Rows returned when the caller names no limit. */
const DEFAULT_RECENT = 50;

export interface CallSummaryRow {
  id: string;
  botKey: string;
  laneKey: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  personalityId: string | null;
  tier: 'pipeline' | 'realtime' | null;
  status: CallStatus;
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
  /** Post-call summary truncated to {@link SUMMARY_PREVIEW_CHARS}. */
  summaryPreview: string | null;
  hasTranscript: boolean;
  costUsd: number | null;
}

export interface CallDetailRow extends CallSummaryRow {
  summary: string | null;
  transcript: string | null;
}

export interface CallsListOptions {
  limit?: number;
  direction?: CallDirection;
  status?: CallStatus;
}

export interface CallsServiceOptions {
  /** Ethos home directory — the log sits at `<dataDir>/calls.db`. */
  dataDir: string;
  /** Used ONLY to answer "does the call log exist yet". */
  storage: Storage;
  /**
   * Open a call log at `path`. Seam for tests; production is the SQLite one.
   * Called at most once per process (see {@link CallsService.open}).
   */
  openLog?: (path: string) => CallLog;
}

function toSummary(call: CallRecord): CallSummaryRow {
  return {
    id: call.id,
    botKey: call.botKey,
    laneKey: call.laneKey,
    direction: call.direction,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    personalityId: call.personalityId ?? null,
    tier: call.tier ?? null,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt ?? null,
    reason: call.reason ?? null,
    summaryPreview: call.summary ? call.summary.slice(0, SUMMARY_PREVIEW_CHARS) : null,
    hasTranscript: Boolean(call.transcript),
    costUsd: call.costUsd ?? null,
  };
}

export class CallsService {
  private readonly path: string;
  private log: CallLog | null = null;

  constructor(private readonly opts: CallsServiceOptions) {
    this.path = join(opts.dataDir, 'calls.db');
  }

  /**
   * Recent calls, newest first.
   *
   * When a filter is supplied the widest window is read and narrowed HERE, not
   * pushed into the `limit`: filtering after a limited read would return "the
   * inbound calls among the last 20", which is not what "the last 20 inbound
   * calls" means, and the list would look empty on a busy outbound day. 200 rows
   * is the log's own ceiling, so the read stays bounded either way.
   */
  async list(opts: CallsListOptions = {}): Promise<CallSummaryRow[]> {
    const log = await this.open();
    if (!log) return [];
    const limit = opts.limit ?? DEFAULT_RECENT;
    const filtered = opts.direction !== undefined || opts.status !== undefined;
    const calls = await log.listRecent({ limit: filtered ? MAX_RECENT_CALLS : limit });
    return calls
      .filter(
        (c) =>
          (opts.direction === undefined || c.direction === opts.direction) &&
          (opts.status === undefined || c.status === opts.status),
      )
      .slice(0, limit)
      .map(toSummary);
  }

  /** Calls that are up right now (`ringing` or `live`), oldest first. */
  async active(): Promise<CallSummaryRow[]> {
    const log = await this.open();
    if (!log) return [];
    return (await log.listLive()).map(toSummary);
  }

  /** One call with its summary and transcript, or null for an unknown id. */
  async get(id: string): Promise<CallDetailRow | null> {
    const log = await this.open();
    if (!log) return null;
    const call = await log.get(id);
    if (!call) return null;
    return {
      ...toSummary(call),
      summary: call.summary ?? null,
      transcript: call.transcript ?? null,
    };
  }

  /**
   * The call-log handle, or null while the file does not exist.
   *
   * Constructed lazily and kept: the gateway holds the same file open, and
   * re-opening a WAL database on every request would churn -wal/-shm handles for
   * nothing. Opening it eagerly would CREATE it (the constructor mkdirs and
   * migrates), so a deployment with no telephony would grow an empty database
   * the first time someone opened the Communications tab — a write performed by
   * a read, for no information.
   */
  private async open(): Promise<CallLog | null> {
    const existing = this.log;
    if (existing) return existing;
    if (!(await this.opts.storage.exists(this.path))) return null;
    const opened = (this.opts.openLog ?? ((p: string) => new SQLiteCallLog({ path: p })))(
      this.path,
    );
    this.log = opened;
    return opened;
  }
}
