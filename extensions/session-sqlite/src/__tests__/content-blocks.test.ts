import type { MessageContent } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// C2 — inline vision/document blocks must survive a store/reload round trip, so
// a resumed session re-sends the same blocks instead of silently degrading to
// the `<attachments>` annotation.

const baseSession = {
  key: 'cli:vision',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

// 1x1 transparent PNG — small enough to inline, real enough to be base64.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_B64 = 'JVBERi0xLjQKJeLjz9MK';

describe('StoredMessage.contentBlocks round trip', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips image and document blocks alongside the annotation text', async () => {
    const session = await store.createSession(baseSession);
    const contentBlocks: MessageContent[] = [
      { type: 'image', mediaType: 'image/png', data: PNG_B64 },
      { type: 'document', mediaType: 'application/pdf', data: PDF_B64 },
    ];

    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '<attachments>\nshot.png (1 KB)\nreport.pdf (2 KB)\n</attachments>\nwhat broke?',
      contentBlocks,
    });

    const [read] = await store.getMessages(session.id);
    expect(read?.contentBlocks).toEqual(contentBlocks);
    // The annotation stays in `content` — it is what block aging falls back to.
    expect(read?.content).toContain('<attachments>');
  });

  it('leaves contentBlocks absent on rows that never had blocks', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'plain text turn',
    });

    const [read] = await store.getMessages(session.id);
    expect(read?.contentBlocks).toBeUndefined();
  });

  it('keeps base64 payloads out of the full-text index', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'screenshot of the crash',
      contentBlocks: [{ type: 'image', mediaType: 'image/png', data: PNG_B64 }],
    });

    // The annotation text is searchable; the block payload is not. This is the
    // reason blocks live in their own column instead of widening `content`.
    expect(await store.search('screenshot')).toHaveLength(1);
    expect(await store.search('iVBORw0KGgo')).toHaveLength(0);
  });
});
