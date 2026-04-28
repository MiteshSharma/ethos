// SessionStreamBuffer — per-session ring buffer for SSE replay on reconnect.
//
// Per Phase 26 eng-review (finding 1.4) and CEO-review additions: the web
// surface streams agent events to the browser via SSE. When a client
// disconnects mid-stream and reconnects within `reapMs`, the buffer replays
// every event after the client's last seen `Last-Event-ID`. After the reap
// timer fires (default 5min), the session's history is dropped and the next
// connection starts fresh.

export interface BufferedEvent<E> {
  /** Monotonic per-key sequence number, 1-indexed. */
  seq: number;
  event: E;
}

export interface SessionStreamBufferOptions {
  /** Max events kept per session before oldest are evicted. Default 1000. */
  capacity?: number;
  /** Ms to retain a disconnected session before clearing it. Default 5min. */
  reapMs?: number;
}

export class SessionStreamBuffer<E = unknown> {
  private readonly capacity: number;
  private readonly reapMs: number;
  private buffers = new Map<string, BufferedEvent<E>[]>();
  private heads = new Map<string, number>();
  private reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Called when a session's reap timer fires — i.e. nothing has touched
   * the buffer for `reapMs` after `disconnect()`. Owners (e.g. ChatService)
   * use this to clean up sibling state (the per-session `AgentBridge`).
   * Set after construction; the buffer doesn't need it for its own work.
   */
  onReap?: (sessionId: string) => void;

  constructor(options: SessionStreamBufferOptions = {}) {
    this.capacity = options.capacity ?? 1000;
    this.reapMs = options.reapMs ?? 5 * 60 * 1000;
  }

  /**
   * Append an event to the session's buffer, returning its assigned seq.
   * Cancels any pending reap (the session is active again).
   */
  append(sessionId: string, event: E): number {
    this.touch(sessionId);
    const seq = (this.heads.get(sessionId) ?? 0) + 1;
    this.heads.set(sessionId, seq);

    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    buf.push({ seq, event });
    if (buf.length > this.capacity) {
      buf.splice(0, buf.length - this.capacity);
    }
    return seq;
  }

  /**
   * Return events with seq > sinceSeq. Pass 0 (or omit) to replay everything
   * still in the buffer. Useful when an SSE client reconnects with a
   * `Last-Event-ID` header.
   */
  replay(sessionId: string, sinceSeq = 0): BufferedEvent<E>[] {
    const buf = this.buffers.get(sessionId);
    if (!buf) return [];
    if (sinceSeq <= 0) return buf.slice();
    // Buffer is append-ordered; binary search would be overkill at N≤1000.
    const out: BufferedEvent<E>[] = [];
    for (const e of buf) if (e.seq > sinceSeq) out.push(e);
    return out;
  }

  /** Current head seq for a session (0 if none recorded). */
  head(sessionId: string): number {
    return this.heads.get(sessionId) ?? 0;
  }

  /**
   * Cancel any pending reap for this session. Called automatically on
   * `append` and explicitly when a client connects.
   */
  touch(sessionId: string): void {
    const t = this.reapTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.reapTimers.delete(sessionId);
    }
  }

  /** Mark the session disconnected — start the reap timer if not already. */
  disconnect(sessionId: string): void {
    if (this.reapTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.buffers.delete(sessionId);
      this.heads.delete(sessionId);
      this.reapTimers.delete(sessionId);
      // Fire AFTER our internal cleanup so owners observing the reap see
      // the buffer already empty for this id. Failures in the callback
      // are isolated — the buffer's own teardown is already done.
      try {
        this.onReap?.(sessionId);
      } catch {
        // Owner-side bug shouldn't kill the buffer.
      }
    }, this.reapMs);
    if (typeof t.unref === 'function') t.unref();
    this.reapTimers.set(sessionId, t);
  }

  /** Force-drop a session's buffer immediately (e.g. /new reset). */
  clear(sessionId: string): void {
    this.touch(sessionId);
    this.buffers.delete(sessionId);
    this.heads.delete(sessionId);
  }

  /**
   * Snapshot of session ids the buffer currently holds. Used by the
   * web-api's `ChatService.broadcastAll` to fan out push events
   * (cron.fired, mesh.changed, evolve.skill_pending) to every live SSE
   * subscriber without needing a separate global channel.
   */
  activeSessions(): string[] {
    return Array.from(this.buffers.keys());
  }

  /** Stop all timers and clear all buffers (for clean test teardown). */
  destroy(): void {
    for (const t of this.reapTimers.values()) clearTimeout(t);
    this.reapTimers.clear();
    this.buffers.clear();
    this.heads.clear();
  }
}
