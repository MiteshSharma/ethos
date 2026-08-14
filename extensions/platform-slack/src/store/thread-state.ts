// Tracks "this bot has posted in this thread" — needed by the
// `thread_follow` channel mode. JSONL records at
// `~/.ethos/slack/<botKey>/thread-state.jsonl`. The set is in-memory; the
// JSONL is the durable trail so the set rebuilds on restart.

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { z } from 'zod';

const RecordSchema = z.object({
  channel: z.string(),
  threadTs: z.string(),
  firstPostedAt: z.number(),
});
type ThreadStateRecord = z.infer<typeof RecordSchema>;

export class ThreadStateStore {
  private readonly file: string;
  private readonly seen = new Set<string>();
  private loaded = false;

  constructor(
    private readonly storage: Storage,
    private readonly slackDir: string,
    private readonly botKey: string,
  ) {
    this.file = join(slackDir, botKey, 'thread-state.jsonl');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.read(this.file);
    if (raw) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = RecordSchema.safeParse(JSON.parse(trimmed));
          if (parsed.success) this.seen.add(this.key(parsed.data.channel, parsed.data.threadTs));
        } catch {
          // Skip malformed lines — partial writes or manual edits. `safeParse`
          // guards the SCHEMA, not the parse: without this one truncated line
          // throws here and permanently blocks adapter startup.
        }
      }
    }
    this.loaded = true;
  }

  hasBotPosted(channel: string, threadTs: string): boolean {
    return this.seen.has(this.key(channel, threadTs));
  }

  /** Record an outbound post in a thread. Skips writes for keys already
   *  recorded so the JSONL doesn't grow unbounded for chatty threads. */
  async recordPost(channel: string, threadTs: string): Promise<void> {
    await this.load();
    const k = this.key(channel, threadTs);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    await this.storage.mkdir(join(this.slackDir, this.botKey));
    const record: ThreadStateRecord = { channel, threadTs, firstPostedAt: Date.now() };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }

  private key(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }
}
