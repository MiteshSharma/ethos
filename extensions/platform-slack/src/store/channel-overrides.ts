// JSONL-backed per-channel mode overrides.
//
// One file per bot at `~/.ethos/slack/<botKey>/channel-overrides.jsonl`.
// Each line is `{ channel, mode, updatedAt }`. The latest record for a
// channel wins (append-only with a small in-memory index).

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { z } from 'zod';
import { type ChannelMode, ChannelModeSchema } from '../config';

const RecordSchema = z.object({
  channel: z.string(),
  mode: ChannelModeSchema,
  updatedAt: z.number(),
});
type ChannelOverrideRecord = z.infer<typeof RecordSchema>;

export class ChannelOverrideStore {
  private readonly file: string;
  private readonly index = new Map<string, ChannelMode>();
  private loaded = false;

  constructor(
    private readonly storage: Storage,
    private readonly slackDir: string,
    private readonly botKey: string,
  ) {
    this.file = join(slackDir, botKey, 'channel-overrides.jsonl');
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
          const parsed = RecordSchema.safeParse(JSON.parse(trimmed));
          if (parsed.success) this.index.set(parsed.data.channel, parsed.data.mode);
        } catch {
          // Skip malformed lines — partial writes or manual edits. `safeParse`
          // guards the SCHEMA, not the parse: without this one truncated line
          // throws here and permanently blocks adapter startup.
        }
      }
    }
    this.loaded = true;
  }

  get(channel: string): ChannelMode | undefined {
    return this.index.get(channel);
  }

  async set(channel: string, mode: ChannelMode): Promise<void> {
    await this.load();
    this.index.set(channel, mode);
    await this.storage.mkdir(join(this.slackDir, this.botKey));
    const record: ChannelOverrideRecord = { channel, mode, updatedAt: Date.now() };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Snapshot of all channel→mode entries; useful for /ethos help. */
  entries(): Array<[string, ChannelMode]> {
    return Array.from(this.index.entries());
  }
}
