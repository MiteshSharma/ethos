import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageDedupCache } from '../dedup';

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
