// PendingMemoryStore + TombstoneStore (memory-lifecycle L2, §3b).
//
// Both are JSONL, one object per line, in the memory scope dir — `cat`-able and
// greppable, the same discipline as `memory-history.jsonl`. All I/O goes through
// the injected Storage (no raw node:fs), so they work against InMemoryStorage in
// tests. The queue uses read-modify-`writeAtomic` for every mutation: a partial
// write to the parked-candidate list would silently drop a user's memory.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import type {
  ApplyFn,
  PendingEntry,
  PendingGateObservability,
  ProposeInput,
  TombstoneRecord,
} from './types';

const PENDING_FILE = 'memory-pending.jsonl';
const TOMBSTONE_FILE = 'memory-tombstones.jsonl';

const DEFAULT_CAP = 200;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the scope dir the same way `HistoryStore.scopeDir` does, so the queue
 * and tombstone files land next to `memory-history.jsonl` and the memory files
 * they gate. Replicated (not imported) to keep this a small leaf module.
 */
export function scopeDir(dataDir: string, scopeId: string): string {
  if (scopeId === 'global') return dataDir;
  if (scopeId.startsWith('personality:')) {
    const id = scopeId.slice('personality:'.length);
    if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
    return join(dataDir, 'personalities', id);
  }
  if (scopeId.startsWith('team:')) {
    const id = scopeId.slice('team:'.length);
    if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
    return dataDir;
  }
  if (scopeId.startsWith('user:')) {
    const id = scopeId.slice('user:'.length);
    if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
    return join(dataDir, 'users', id);
  }
  throw new Error(`unrecognised memory scope: ${scopeId}`);
}

function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export interface TombstoneStoreOptions {
  storage: Storage;
  dataDir: string;
}

/**
 * Append-only list of rejected/expired fact-hashes per scope. Capture consults
 * `has()` in its eligibility check so a retracted fact is never re-proposed.
 */
export class TombstoneStore {
  private readonly storage: Storage;
  private readonly dataDir: string;

  constructor(opts: TombstoneStoreOptions) {
    this.storage = opts.storage;
    this.dataDir = opts.dataDir;
  }

  private path(scopeId: string): string {
    return join(scopeDir(this.dataDir, scopeId), TOMBSTONE_FILE);
  }

  async add(scopeId: string, factHash: string, reason?: string): Promise<void> {
    const dir = scopeDir(this.dataDir, scopeId);
    await this.storage.mkdir(dir);
    const record: TombstoneRecord = { factHash, ts: Date.now(), ...(reason ? { reason } : {}) };
    await this.storage.append(this.path(scopeId), `${JSON.stringify(record)}\n`);
  }

  async has(scopeId: string, factHash: string): Promise<boolean> {
    for (const rec of await this.list(scopeId)) {
      if (rec.factHash === factHash) return true;
    }
    return false;
  }

  async list(scopeId: string): Promise<TombstoneRecord[]> {
    const raw = await this.storage.read(this.path(scopeId));
    if (raw === null) return [];
    const out: TombstoneRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = parse<TombstoneRecord>(line, (o) => typeof o.factHash === 'string');
      if (parsed) out.push(parsed);
    }
    return out;
  }
}

export interface PendingMemoryStoreOptions {
  storage: Storage;
  dataDir: string;
  tombstones: TombstoneStore;
  /** Replay an approved candidate through the history-recording write path. */
  apply: ApplyFn;
  /** Queue hard cap per scope. Default 200. At cap the oldest entry is dropped. */
  cap?: number;
  /** Candidate TTL in ms. Default 30 days. Expired entries auto-reject on read. */
  ttlMs?: number;
  observability?: PendingGateObservability;
  /** Test seam. */
  now?: () => number;
}

/**
 * The parked-candidate queue. `propose` enqueues, `approve` replays + removes,
 * `reject` tombstones + removes, `list` prunes expired candidates (auto-reject,
 * never auto-approve). Cap + expiry are the two back-pressure valves.
 */
export class PendingMemoryStore {
  private readonly storage: Storage;
  private readonly dataDir: string;
  private readonly tombstones: TombstoneStore;
  private readonly apply: ApplyFn;
  private readonly cap: number;
  private readonly ttlMs: number;
  private readonly observability?: PendingGateObservability;
  private readonly now: () => number;
  /** Accumulated host-pause duration discounted from the TTL clock. */
  private pauseOffsetMs = 0;
  /** Wall clock at the most recent `applyPauseOffset`. Entries proposed at or
   *  after this were stamped by a correct clock and get no discount. */
  private pauseBoundaryAt = 0;

  constructor(opts: PendingMemoryStoreOptions) {
    this.storage = opts.storage;
    this.dataDir = opts.dataDir;
    this.tombstones = opts.tombstones;
    this.apply = opts.apply;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.observability = opts.observability;
    this.now = opts.now ?? (() => Date.now());
  }

  private path(scopeId: string): string {
    return join(scopeDir(this.dataDir, scopeId), PENDING_FILE);
  }

  /**
   * Discount a host pause from the pending-candidate TTL clock.
   *
   * A snapshot-and-restore host advances wall-clock time while the guest is
   * frozen, so a candidate with days of TTL left when the host paused would be
   * auto-rejected on the first post-resume prune, though its 30-day window was
   * never exhausted in owner-visible time.
   *
   * Deliberate, documented divergence from `plan/phases/clock-tolerance-pass.md`
   * §3, which words gate #9's fix as bumping every live entry's `proposedAt`
   * forward: entries live in per-scope JSONL files and this store has no
   * scope-enumeration API, so rewriting them would require inventing one.
   * Shifting the cutoff by the same amount is arithmetically identical for
   * every entry THAT EXISTED WHEN THE HOST PAUSED, needs no I/O, and cannot
   * partially fail — the plan's stated intent, reached by the cheaper route.
   * Successive pauses accumulate.
   *
   * BOUNDED BY THE RESUME BOUNDARY. The equivalence above holds only for
   * entries the pause actually happened to. A candidate proposed AFTER the
   * resume had its `proposedAt` stamped by an already-correct clock, so
   * discounting the pause from its cutoff would hand it extra TTL it never
   * lost — and successive pauses would compound that indefinitely, eventually
   * meaning nothing ever expires. `pauseBoundaryAt` records when the discount
   * was applied so `prune` can tell the two populations apart; that is what
   * keeps this as self-limiting as the per-entry bump the plan describes.
   *
   * Non-positive or non-finite durations are a no-op.
   */
  applyPauseOffset(pauseDurationMs: number): void {
    if (!Number.isFinite(pauseDurationMs) || pauseDurationMs <= 0) return;
    this.pauseOffsetMs += pauseDurationMs;
    this.pauseBoundaryAt = this.now();
  }

  private async readAll(scopeId: string): Promise<PendingEntry[]> {
    const raw = await this.storage.read(this.path(scopeId));
    if (raw === null) return [];
    const out: PendingEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = parse<PendingEntry>(
        line,
        (o) => typeof o.id === 'string' && typeof o.scopeId === 'string',
      );
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private async writeAll(scopeId: string, entries: PendingEntry[]): Promise<void> {
    const dir = scopeDir(this.dataDir, scopeId);
    await this.storage.mkdir(dir);
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    await this.storage.writeAtomic(this.path(scopeId), body.length > 0 ? `${body}\n` : '');
  }

  /** Enqueue a candidate. Prunes expired entries and enforces the cap first. */
  async propose(input: ProposeInput): Promise<PendingEntry> {
    const entries = await this.prune(input.scopeId, await this.readAll(input.scopeId));

    const entry: PendingEntry = {
      id: randomUUID(),
      scopeId: input.scopeId,
      update: input.update,
      source: input.source,
      proposedAt: this.now(),
      ...(input.factHash ? { factHash: input.factHash } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    };
    entries.push(entry);

    // Drop oldest (front of the list) until under cap, signalling each drop.
    while (entries.length > this.cap) {
      const dropped = entries.shift();
      if (!dropped) break;
      this.observability?.onCapExceeded({
        scopeId: input.scopeId,
        droppedId: dropped.id,
        cap: this.cap,
      });
    }

    await this.writeAll(input.scopeId, entries);
    return entry;
  }

  /** Live (non-expired) candidates for a scope, oldest first. */
  async list(scopeId: string): Promise<PendingEntry[]> {
    const entries = await this.prune(scopeId, await this.readAll(scopeId));
    return entries;
  }

  async approve(
    scopeId: string,
    id: string,
    approvedBy: string,
  ): Promise<{ ok: boolean; entry?: PendingEntry }> {
    const entries = await this.prune(scopeId, await this.readAll(scopeId));
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false };
    await this.apply(entry, approvedBy);
    await this.writeAll(
      scopeId,
      entries.filter((e) => e.id !== id),
    );
    return { ok: true, entry };
  }

  async reject(
    scopeId: string,
    id: string,
    reason?: string,
  ): Promise<{ ok: boolean; entry?: PendingEntry }> {
    const entries = await this.prune(scopeId, await this.readAll(scopeId));
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false };
    if (entry.factHash) await this.tombstones.add(scopeId, entry.factHash, reason);
    await this.writeAll(
      scopeId,
      entries.filter((e) => e.id !== id),
    );
    return { ok: true, entry };
  }

  /**
   * Drop candidates older than the TTL. Expiry is an auto-REJECT (never
   * auto-approve, §5b): an expired capture fact is tombstoned so it isn't
   * re-proposed. Returns the survivors and persists them when anything changed.
   */
  private async prune(scopeId: string, entries: PendingEntry[]): Promise<PendingEntry[]> {
    if (this.ttlMs <= 0) return entries;
    const baseCutoff = this.now() - this.ttlMs;
    const live: PendingEntry[] = [];
    const expired: PendingEntry[] = [];
    for (const e of entries) {
      // Only entries that predate the resume lost time to the pause; see
      // `applyPauseOffset` for why a blanket discount compounds without bound.
      const cutoff =
        e.proposedAt < this.pauseBoundaryAt ? baseCutoff - this.pauseOffsetMs : baseCutoff;
      if (e.proposedAt < cutoff) expired.push(e);
      else live.push(e);
    }
    if (expired.length === 0) return entries;
    for (const e of expired) {
      if (e.factHash) await this.tombstones.add(scopeId, e.factHash, 'expired');
    }
    await this.writeAll(scopeId, live);
    return live;
  }
}

function parse<T>(line: string, ok: (o: Record<string, unknown>) => boolean): T | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return ok(obj) ? (obj as unknown as T) : null;
  } catch {
    return null;
  }
}
