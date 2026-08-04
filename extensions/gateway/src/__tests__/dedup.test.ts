import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DedupDropInfo, MessageDedupCache } from '../dedup';

describe('MessageDedupCache', () => {
  const originalEnv = process.env.ETHOS_DEDUP_LEGACY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ETHOS_DEDUP_LEGACY;
    else process.env.ETHOS_DEDUP_LEGACY = originalEnv;
  });

  it('suppresses the same (sessionId, content) within ttl', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
  });

  it('treats different sessions as independent', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s2', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
    expect(cache.shouldSend('s2', 'hello')).toBe(false);
  });

  it('treats different content as independent', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'world')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
  });

  it('admits a duplicate after the ttl elapses', async () => {
    const cache = new MessageDedupCache({ ttlMs: 10 });

    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
    await new Promise((r) => setTimeout(r, 25));
    expect(cache.shouldSend('s1', 'hello')).toBe(true);
  });

  it('never dedups empty content', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', '')).toBe(true);
    expect(cache.shouldSend('s1', '')).toBe(true);
  });

  it('clearSession forgets every key for that session', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', 'a')).toBe(true);
    expect(cache.shouldSend('s1', 'b')).toBe(true);
    expect(cache.shouldSend('s2', 'a')).toBe(true);

    cache.clearSession('s1');

    expect(cache.shouldSend('s1', 'a')).toBe(true);
    expect(cache.shouldSend('s1', 'b')).toBe(true);
    // s2 untouched
    expect(cache.shouldSend('s2', 'a')).toBe(false);
  });

  it('clearSession matches the sessionId exactly and spares sibling thread lanes', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    // Root lane and a threaded sibling — the root is a colon-prefix of the thread.
    expect(cache.shouldSend('a:b:c', 'hi')).toBe(true);
    expect(cache.shouldSend('a:b:c:d', 'hi')).toBe(true);

    cache.clearSession('a:b:c');

    // Root lane forgotten...
    expect(cache.shouldSend('a:b:c', 'hi')).toBe(true);
    // ...but the threaded sibling's entry survives (still suppressed).
    expect(cache.shouldSend('a:b:c:d', 'hi')).toBe(false);
  });

  it('ETHOS_DEDUP_LEGACY=1 disables the cache entirely', () => {
    process.env.ETHOS_DEDUP_LEGACY = '1';
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(cache.shouldSend('s1', 'hello')).toBe(true);
  });

  it('bounds the cache size by evicting oldest entries', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000, maxEntries: 3 });

    cache.shouldSend('s', 'a');
    cache.shouldSend('s', 'b');
    cache.shouldSend('s', 'c');
    cache.shouldSend('s', 'd');

    expect(cache.size()).toBe(3);
    // 'a' was evicted, so it's sendable again
    expect(cache.shouldSend('s', 'a')).toBe(true);
    // 'd' was the most recent insertion; still suppressed
    expect(cache.shouldSend('s', 'd')).toBe(false);
  });
});

describe('MessageDedupCache — onDrop observability (P5.4)', () => {
  const originalEnv = process.env.ETHOS_DEDUP_LEGACY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ETHOS_DEDUP_LEGACY;
    else process.env.ETHOS_DEDUP_LEGACY = originalEnv;
  });

  it('fires onDrop exactly once per genuine duplicate — not on first send or empty content', () => {
    const drops: DedupDropInfo[] = [];
    const cache = new MessageDedupCache({ ttlMs: 60_000, onDrop: (i) => drops.push(i) });

    // First send: admitted, no drop.
    expect(cache.shouldSend('s1', 'hello')).toBe(true);
    expect(drops).toHaveLength(0);

    // Duplicate: dropped, exactly one event.
    expect(cache.shouldSend('s1', 'hello')).toBe(false);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ sessionId: 's1', contentLength: 5 });
    expect(drops[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Content only, never the plaintext.
    expect(JSON.stringify(drops[0])).not.toContain('hello');

    // Empty content is never deduped and never drops.
    expect(cache.shouldSend('s1', '')).toBe(true);
    expect(cache.shouldSend('s1', '')).toBe(true);
    expect(drops).toHaveLength(1);
  });

  it('does not fire onDrop on the disabled (legacy) path', () => {
    process.env.ETHOS_DEDUP_LEGACY = '1';
    const drops: DedupDropInfo[] = [];
    const cache = new MessageDedupCache({ ttlMs: 60_000, onDrop: (i) => drops.push(i) });

    cache.shouldSend('s1', 'x');
    cache.shouldSend('s1', 'x');
    expect(drops).toHaveLength(0);
  });

  it('does not fire onDrop when a stale (expired) entry is refreshed', async () => {
    const drops: DedupDropInfo[] = [];
    const cache = new MessageDedupCache({ ttlMs: 10, onDrop: (i) => drops.push(i) });

    expect(cache.shouldSend('s1', 'x')).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    // Re-send after TTL: admitted (not a drop), so onDrop must NOT fire.
    expect(cache.shouldSend('s1', 'x')).toBe(true);
    expect(drops).toHaveLength(0);
  });
});

describe('MessageDedupCache — record() (W3.1 streaming-final + item 9 redelivery)', () => {
  const originalEnv = process.env.ETHOS_DEDUP_LEGACY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ETHOS_DEDUP_LEGACY;
    else process.env.ETHOS_DEDUP_LEGACY = originalEnv;
  });

  it('a recorded (sessionId, content) is then suppressed by shouldSend (REGRESSION)', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    // Streaming path delivers the final via editMessage (bypasses shouldSend),
    // then registers it. A subsequent duplicate send() must be suppressed.
    cache.record('s1', 'the full final reply');
    expect(cache.shouldSend('s1', 'the full final reply')).toBe(false);
  });

  it('record does not fire onDrop and does not suppress different content', () => {
    const drops: DedupDropInfo[] = [];
    const cache = new MessageDedupCache({ ttlMs: 60_000, onDrop: (i) => drops.push(i) });

    cache.record('s1', 'final');
    expect(drops).toHaveLength(0);
    // Different content is still sendable.
    expect(cache.shouldSend('s1', 'other')).toBe(true);
    // The recorded content is suppressed (this shouldSend does fire onDrop).
    expect(cache.shouldSend('s1', 'final')).toBe(false);
    expect(drops).toHaveLength(1);
  });

  it('record is a no-op for empty content and on the legacy path', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });
    cache.record('s1', '');
    expect(cache.shouldSend('s1', '')).toBe(true); // empty never deduped

    process.env.ETHOS_DEDUP_LEGACY = '1';
    const legacy = new MessageDedupCache({ ttlMs: 60_000 });
    legacy.record('s1', 'final');
    expect(legacy.shouldSend('s1', 'final')).toBe(true); // legacy disables dedup
  });

  it('a warm entry never blocks a redelivery, but the redelivery re-arms it (item 9)', () => {
    // The delivery-ledger sweep deliberately does NOT consult shouldSend: an
    // obligation is pending precisely because the user never received it, and
    // a cache warmed by the failed attempt must not swallow the retry. It
    // calls record() afterwards instead, so the NEXT duplicate is suppressed.
    const cache = new MessageDedupCache({ ttlMs: 60_000 });
    const session = 'telegram:bot-a:chat-1';

    // The original (failed) send warmed the cache on its way out.
    expect(cache.shouldSend(session, 'the answer')).toBe(true);

    // Redelivery bypasses the cache entirely — nothing here can return false —
    // and re-arms it on the way out.
    cache.record(session, 'the answer');

    // A genuine duplicate after the redelivery is still suppressed.
    expect(cache.shouldSend(session, 'the answer')).toBe(false);
  });

  it('a recorded entry is honored by clearSession', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });
    cache.record('chat:9', 'reply');
    expect(cache.shouldSend('chat:9', 'reply')).toBe(false);
    cache.clearSession('chat:9');
    expect(cache.shouldSend('chat:9', 'reply')).toBe(true);
  });
});

describe('MessageDedupCache — sessionId persists across `/new`', () => {
  beforeEach(() => {
    delete process.env.ETHOS_DEDUP_LEGACY;
  });

  it('does not suppress identical content sent under a fresh session key', () => {
    const cache = new MessageDedupCache({ ttlMs: 60_000 });

    expect(cache.shouldSend('chat:42', 'pong')).toBe(true);
    expect(cache.shouldSend('chat:42', 'pong')).toBe(false);

    // /new generates a new session key; the dedup state for the old session
    // is cleared, but a fresh key would also bypass on its own.
    expect(cache.shouldSend('chat:42:1700000000000', 'pong')).toBe(true);
  });
});
