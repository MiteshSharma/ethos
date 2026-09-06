// JSONL-backed per-channel mode overrides, shared by every channel adapter.
//
// One file per bot at `<baseDir>/channel-overrides.jsonl`. Each line is
// `{ channel, mode, updatedAt, regexPattern? }`; the latest record for a
// channel wins (append-only with a small in-memory index).
//
// Slack, Telegram and Discord each carried a near-identical copy of this.
// They had drifted: Telegram indexed `{ mode, regexPattern }` while the other
// two indexed a bare mode, and Telegram took the per-bot directory directly
// while the other two joined `botKey` themselves. This is the one
// implementation; adapters supply the per-bot directory and their own mode
// enum.

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

/**
 * The validation seam for an adapter's mode enum.
 *
 * Structural on purpose: a zod enum (`z.enum([...])`) satisfies it as-is, so
 * an adapter passes `ChannelModeSchema` straight in — but `@ethosagent/core`
 * keeps its zero external runtime dependencies. Anything else with a
 * `safeParse` of this shape works equally well.
 */
export interface ChannelModeParser<Mode extends string> {
  safeParse(value: unknown): { success: true; data: Mode } | { success: false };
}

/**
 * One channel's stored override. `regexPattern` is only meaningful to adapters
 * with a `regex_match` mode.
 *
 * `mode` is `string`, NOT the adapter's `Mode`, and the asymmetry with `set`
 * — which still takes `Mode` — is the point. A record whose mode this build's
 * parser REJECTS is kept, carrying the rejected string verbatim, so that the
 * adapter's `override?.mode ?? default` hands the unreadable value to
 * `evaluateChannelMode`, which fails closed on a mode it does not know.
 *
 * Dropping the record instead — what this did before — made `get()` return
 * `undefined`, indistinguishable from "no override stored", so every adapter
 * substituted its configured default. That default is `mention_only`, an
 * ANSWERING mode, and config-sourced defaults are validated too: the
 * fail-closed branch in `evaluateChannelMode` could therefore never be
 * reached in production. A trailing space, a capital letter, a typo, or a
 * silent mode written by a newer binary each turned a room that had asked for
 * silence into an answering bot.
 *
 * The distinction the adapters rely on is therefore: `undefined` means NO
 * override is stored (fall back to the configured default — still correct);
 * a `mode` the adapter's enum does not contain means an override IS stored
 * and this build cannot read it (neither answer nor record).
 *
 * The second half of that sentence is enforced by `evaluateChannelMode`
 * (`./channel-mode`), which refuses any mode outside the `supportedModes` it
 * is handed, and by each adapter passing its OWN `CHANNEL_MODES` const —
 * the same list its `ChannelModeSchema` is built from, so the enum that
 * rejects a record here and the set that refuses to act on it there cannot
 * drift apart. It used to test a hard-coded union of all four adapters'
 * enums, under which a `regex_match` line in a Slack override file was
 * "recognised" by a build that has no such mode. `parseRecord` kept it, and
 * the evaluator then answered mentions in that channel while recording
 * nothing. Pinned by `packages/core/src/__tests__/channel-mode.test.ts`
 * ("a mode from another adapter's enum") and by each adapter's
 * `__tests__/unreadable-mode.test.ts`.
 */
export interface ChannelOverrideEntry {
  mode: string;
  regexPattern?: string;
}

interface ChannelOverrideRecord extends ChannelOverrideEntry {
  channel: string;
  updatedAt: number;
}

function parseRecord<Mode extends string>(
  value: unknown,
  modes: ChannelModeParser<Mode>,
): ChannelOverrideRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw: Record<string, unknown> = value as Record<string, unknown>;
  const { channel, updatedAt, regexPattern } = raw;
  if (typeof channel !== 'string') return undefined;
  if (typeof updatedAt !== 'number') return undefined;
  if (regexPattern !== undefined && typeof regexPattern !== 'string') return undefined;
  // A non-string `mode` is a STRUCTURALLY malformed record, in the same class
  // as the truncated line `load()` already discards — not a mode this build
  // cannot read. It stays dropped; only a string the parser rejects is kept.
  if (typeof raw.mode !== 'string') return undefined;
  const mode = modes.safeParse(raw.mode);
  return {
    channel,
    // Rejected: the raw string, which no adapter enum contains and
    // `evaluateChannelMode` therefore refuses to act on.
    mode: mode.success ? mode.data : raw.mode,
    updatedAt,
    ...(regexPattern !== undefined && { regexPattern }),
  };
}

export class ChannelOverrideStore<Mode extends string> {
  private readonly file: string;
  private readonly index = new Map<string, ChannelOverrideEntry>();
  private loaded = false;

  /**
   * @param storage  Where the JSONL lives. Never raw `node:fs` (L7).
   * @param baseDir  The PER-BOT directory, e.g. `~/.ethos/discord/<botKey>`.
   *   Callers that keep a platform dir and a botKey separately join them.
   * @param modes    The adapter's mode enum. A line whose mode it rejects is
   *   KEPT with its raw string rather than skipped — see
   *   `ChannelOverrideEntry`. Widening an enum still never has to migrate the
   *   file: an unknown mode is never adopted as a valid one, it is only
   *   preserved so the caller can refuse to act on it.
   */
  constructor(
    private readonly storage: Storage,
    private readonly baseDir: string,
    private readonly modes: ChannelModeParser<Mode>,
  ) {
    this.file = join(baseDir, 'channel-overrides.jsonl');
  }

  /** Load existing records into the in-memory index. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.read(this.file);
    if (raw) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = parseRecord(JSON.parse(trimmed), this.modes);
          if (record) {
            this.index.set(record.channel, {
              mode: record.mode,
              ...(record.regexPattern !== undefined && { regexPattern: record.regexPattern }),
            });
          }
        } catch {
          // Skip malformed lines — partial writes or manual edits. The guard is
          // around the PARSE, not just the schema: without it one truncated
          // line throws here and permanently blocks adapter startup.
        }
      }
    }
    this.loaded = true;
  }

  get(channel: string): ChannelOverrideEntry | undefined {
    return this.index.get(channel);
  }

  async set(channel: string, mode: Mode, regexPattern?: string): Promise<void> {
    await this.load();
    const entry: ChannelOverrideEntry = {
      mode,
      ...(regexPattern !== undefined && { regexPattern }),
    };
    this.index.set(channel, entry);
    await this.storage.mkdir(this.baseDir);
    const record: ChannelOverrideRecord = { channel, ...entry, updatedAt: Date.now() };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Snapshot of all channel entries; useful for diagnostics and `/ethos help`. */
  entries(): Array<[string, ChannelOverrideEntry]> {
    return Array.from(this.index.entries());
  }
}
