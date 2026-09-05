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
export interface ChannelModeParser<Mode> {
  safeParse(value: unknown): { success: true; data: Mode } | { success: false };
}

/** One channel's stored override. `regexPattern` is only meaningful to adapters with a `regex_match` mode. */
export interface ChannelOverrideEntry<Mode> {
  mode: Mode;
  regexPattern?: string;
}

interface ChannelOverrideRecord<Mode> extends ChannelOverrideEntry<Mode> {
  channel: string;
  updatedAt: number;
}

function parseRecord<Mode>(
  value: unknown,
  modes: ChannelModeParser<Mode>,
): ChannelOverrideRecord<Mode> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw: Record<string, unknown> = value as Record<string, unknown>;
  const { channel, updatedAt, regexPattern } = raw;
  if (typeof channel !== 'string') return undefined;
  if (typeof updatedAt !== 'number') return undefined;
  if (regexPattern !== undefined && typeof regexPattern !== 'string') return undefined;
  const mode = modes.safeParse(raw.mode);
  if (!mode.success) return undefined;
  return {
    channel,
    mode: mode.data,
    updatedAt,
    ...(regexPattern !== undefined && { regexPattern }),
  };
}

export class ChannelOverrideStore<Mode> {
  private readonly file: string;
  private readonly index = new Map<string, ChannelOverrideEntry<Mode>>();
  private loaded = false;

  /**
   * @param storage  Where the JSONL lives. Never raw `node:fs` (L7).
   * @param baseDir  The PER-BOT directory, e.g. `~/.ethos/discord/<botKey>`.
   *   Callers that keep a platform dir and a botKey separately join them.
   * @param modes    The adapter's mode enum. Lines whose mode it rejects are
   *   skipped, so widening an enum never has to migrate the file.
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

  get(channel: string): ChannelOverrideEntry<Mode> | undefined {
    return this.index.get(channel);
  }

  async set(channel: string, mode: Mode, regexPattern?: string): Promise<void> {
    await this.load();
    const entry: ChannelOverrideEntry<Mode> = {
      mode,
      ...(regexPattern !== undefined && { regexPattern }),
    };
    this.index.set(channel, entry);
    await this.storage.mkdir(this.baseDir);
    const record: ChannelOverrideRecord<Mode> = { channel, ...entry, updatedAt: Date.now() };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Snapshot of all channel entries; useful for diagnostics and `/ethos help`. */
  entries(): Array<[string, ChannelOverrideEntry<Mode>]> {
    return Array.from(this.index.entries());
  }
}
