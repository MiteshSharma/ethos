import { createHash } from 'node:crypto';

/**
 * Single dedup path for outbound channel messages. Adapter-specific dedup
 * gets pulled into here so a new adapter doesn't need to invent its own
 * idempotency layer. See plan/phases/30-robustness.md § 30.4.
 *
 * Key shape: `${sessionId}:${sha256(content)}`. Same content within `ttlMs`
 * for the same session is a duplicate. Empty content is never deduped.
 *
 * Rollback escape hatch: if `ETHOS_DEDUP_LEGACY=1` is set in the env at
 * cache construction, `shouldSend` always returns true (every send goes
 * through). This restores pre-30.4 behavior in case a regression surfaces
 * in a shipped adapter.
 */
export class MessageDedupCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly disabled: boolean;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 4096;
    this.disabled = process.env.ETHOS_DEDUP_LEGACY === '1' || this.ttlMs <= 0;
  }

  /**
   * Returns `true` if the message is new (and records it). Returns `false`
   * if the same content was sent on the same session within `ttlMs`.
   */
  shouldSend(sessionId: string, content: string): boolean {
    if (this.disabled) return true;
    if (!content) return true;

    const now = Date.now();
    const hash = createHash('sha256').update(content).digest('hex');
    const key = `${sessionId}:${hash}`;

    // Lazy eviction: only check the key we touched. The size cap handles
    // the global bound; a periodic O(N) sweep would dominate hot paths.
    const expiry = this.entries.get(key);
    if (expiry !== undefined) {
      if (expiry > now) return false;
      this.entries.delete(key); // expired — drop so re-insert refreshes order
    }

    this.entries.set(key, now + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  /** Forget every key associated with `sessionId` (called by `/new`). */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
