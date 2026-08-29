// `ethos why` — computeWhy correctness (plan/phases/model-visible-logged.md,
// Phase E). Drives the extracted pure function directly against a fake
// ContextLog (same isolation pattern `cas-gc.test.ts`'s FakeContextLog uses)
// and a real FsContentStore over InMemoryStorage.

import { FsContentStore } from '@ethosagent/cas-fs';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextEvent, ContextLog, ResolvedContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { computeWhy } from '../commands/why';

/** Only `resolveAt` matters to `computeWhy`; the rest throw if ever called. */
class FakeContextLog implements ContextLog {
  constructor(private readonly resolved: ResolvedContext) {}
  async append(_event: ContextEvent): Promise<void> {
    throw new Error('not used by computeWhy');
  }
  async resolveAt(_sessionId: string, _messageId: string): Promise<ResolvedContext> {
    return this.resolved;
  }
  async listRefs(): Promise<string[]> {
    throw new Error('not used by computeWhy');
  }
}

describe('computeWhy', () => {
  it('resolves a Tier A/B (replay) kind — hash/mode/meta/timestamp match, and the fetched blob matches what was put()', async () => {
    const storage = new InMemoryStorage();
    const contentStore = new FsContentStore('/cas', storage);
    const soulBody = '# SOUL\nI am a helpful agent.';
    const hash = await contentStore.put(soulBody);

    const resolved: ResolvedContext = {
      personality: {
        hash,
        mode: 'replay',
        meta: { via: 'initial', soulSha: hash },
        timestamp: 1000,
      },
      memory: 'unknown',
      file_window: 'unknown',
      team_index: 'unknown',
    };
    const contextLog = new FakeContextLog(resolved);

    const result = await computeWhy('session-1', 'msg-1', contextLog, contentStore);

    const personality = result.kinds.personality;
    expect(personality.status).toBe('replay');
    if (personality.status !== 'replay') throw new Error('expected replay');
    expect(personality.hash).toBe(hash);
    expect(personality.mode).toBe('replay');
    expect(personality.meta).toEqual({ via: 'initial', soulSha: hash });
    expect(personality.timestamp).toBe(1000);
    expect(personality.blob.found).toBe(true);
    expect(personality.blob.byteLength).toBe(Buffer.byteLength(soulBody, 'utf-8'));
    expect(personality.blob.preview).toBe(soulBody);
  });

  it("resolves 'unknown' for a kind with no prior event", async () => {
    const storage = new InMemoryStorage();
    const contentStore = new FsContentStore('/cas', storage);
    const resolved: ResolvedContext = {
      personality: 'unknown',
      memory: 'unknown',
      file_window: 'unknown',
      team_index: 'unknown',
    };
    const contextLog = new FakeContextLog(resolved);

    const result = await computeWhy('session-1', 'msg-1', contextLog, contentStore);
    expect(result.kinds.memory).toEqual({ status: 'unknown' });
  });

  it("resolves Tier C (file_window) to mode 'detect', and get() on that hash independently returns null — acceptance criterion 7", async () => {
    const storage = new InMemoryStorage();
    const contentStore = new FsContentStore('/cas', storage);
    // Nothing is ever put() for this hash — Tier C is detect-only, no blob.
    const windowHash = contentStore.hash('some file window content that is never stored');

    const resolved: ResolvedContext = {
      personality: 'unknown',
      memory: 'unknown',
      file_window: {
        hash: windowHash,
        mode: 'detect',
        meta: { paths: ['a.ts', 'b.ts'] },
        timestamp: 2000,
      },
      team_index: 'unknown',
    };
    const contextLog = new FakeContextLog(resolved);

    const result = await computeWhy('session-1', 'msg-1', contextLog, contentStore);

    expect(result.kinds.file_window).toEqual({
      status: 'detect',
      hash: windowHash,
      mode: 'detect',
      meta: { paths: ['a.ts', 'b.ts'] },
      timestamp: 2000,
    });

    // computeWhy never calls get() for a detect-only kind (mode already says
    // there's nothing to fetch). This assertion independently proves get() on
    // that hash returns null, so a future reader cannot mistake the absence
    // of a blob for data loss.
    expect(await contentStore.get(windowHash)).toBeNull();
  });
});
