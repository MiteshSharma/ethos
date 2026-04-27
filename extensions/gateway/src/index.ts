import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { MessageDedupCache } from './dedup';

export { MessageDedupCache } from './dedup';

// ---------------------------------------------------------------------------
// SessionLane — serialises concurrent messages for the same chat
// ---------------------------------------------------------------------------

interface LaneTask {
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class SessionLane {
  private readonly queue: LaneTask[] = [];
  private processing = false;
  private currentAbort: AbortController | null = null;

  enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject });
      void this.drain();
    });
  }

  /** Abort the running task and drop everything queued behind it. */
  abort(): void {
    this.currentAbort?.abort();
    const dropped = this.queue.splice(0);
    for (const item of dropped) {
      item.reject(new Error('aborted'));
    }
  }

  get length(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.currentAbort = new AbortController();
      try {
        await item.run(this.currentAbort.signal);
        item.resolve();
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.currentAbort = null;
    this.processing = false;
  }
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** The agent loop used to process messages. */
  loop: AgentLoop;
  /** Default personality ID used for all sessions. */
  defaultPersonality?: string;
  /** Maximum concurrent active sessions. Excess sessions are queued per-lane. */
  maxConcurrentSessions?: number;
  /**
   * Size of the inbound-message dedup window. The Gateway remembers the most
   * recent N `(platform, chatId, messageId)` triples and silently drops
   * duplicates. Defaults to 1024. Set to 0 to disable dedup.
   * Adapters that don't populate `InboundMessage.messageId` are unaffected
   * (no key, no dedup possible — see plan/IMPROVEMENT.md P2-2).
   */
  dedupWindow?: number;
  /**
   * TTL for the outbound-message dedup cache (`MessageDedupCache`). Same
   * `(sessionId, content)` within this window is suppressed before reaching
   * the adapter. Defaults to 30s. Set to 0 to disable. The
   * `ETHOS_DEDUP_LEGACY=1` env var is a separate, hard-off switch — see
   * `dedup.ts` and plan/phases/30-robustness.md § 30.4.
   */
  outboundDedupTtlMs?: number;
  /**
   * Maximum number of distinct chats kept in memory. The least-recently-used
   * idle chat is evicted (its lane, session key, personality override, and
   * usage stats are forgotten) once this cap is exceeded. Active in-flight
   * lanes are never evicted. Defaults to 4096.
   */
  maxChats?: number;
}

// ---------------------------------------------------------------------------
// Built-in gateway slash commands (handled before the AgentLoop sees the text)
// ---------------------------------------------------------------------------

const PLATFORM_COMMANDS: Record<string, 'new' | 'usage' | 'stop' | 'help' | 'personality'> = {
  '/new': 'new',
  '/reset': 'new',
  '/stop': 'stop',
  '/usage': 'usage',
  '/help': 'help',
  '/personality': 'personality',
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class Gateway {
  private readonly loop: AgentLoop;
  private readonly defaultPersonality: string | undefined;
  private readonly lanes = new Map<string, SessionLane>();
  /** Effective session key per lane (allows /new to fork a fresh session). */
  private readonly sessionKeys = new Map<string, string>();
  /** Per-lane active personality (overrideable via /personality). */
  private readonly personalityIds = new Map<string, string>();
  /** Per-lane usage accumulator. */
  private readonly usageStore = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number }
  >();
  /** Bounded LRU of recently-seen inbound-message keys. */
  private readonly seenMessages = new Set<string>();
  private readonly dedupWindow: number;
  /** Outbound-message dedup cache. Suppresses `(sessionId, content)` within TTL. */
  private readonly outboundDedup: MessageDedupCache;
  /** Active turns by laneKey — used by graceful shutdown to notify users. */
  private readonly activeTurns = new Map<string, { adapter: PlatformAdapter; chatId: string }>();
  private readonly maxChats: number;

  constructor(config: GatewayConfig) {
    this.loop = config.loop;
    this.defaultPersonality = config.defaultPersonality;
    this.dedupWindow = config.dedupWindow ?? 1024;
    this.maxChats = config.maxChats ?? 4096;
    // ttlMs <= 0 disables dedup inside the cache itself (shouldSend always returns true).
    this.outboundDedup = new MessageDedupCache({ ttlMs: config.outboundDedupTtlMs ?? 30_000 });
  }

  /**
   * Returns true if this message is a duplicate of one seen in the dedup
   * window (and records the key for future drops). Returns false for
   * never-before-seen keys, or when the message has no `messageId` (we can't
   * dedup what isn't keyed).
   */
  private isDuplicate(message: InboundMessage): boolean {
    if (this.dedupWindow <= 0 || !message.messageId) return false;
    const key = `${message.platform}:${message.chatId}:${message.messageId}`;
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.add(key);
    // Bound the set — drop the oldest entry once we exceed the window.
    if (this.seenMessages.size > this.dedupWindow) {
      const first = this.seenMessages.values().next().value;
      if (first !== undefined) this.seenMessages.delete(first);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API — adapters call this for every inbound message
  // ---------------------------------------------------------------------------

  async handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void> {
    // Drop duplicates BEFORE any work — billing-relevant. See OpenClaw #71761
    // (channel messages injected twice → 2× cost).
    if (this.isDuplicate(message)) return;

    const laneKey = `${message.platform}:${message.chatId}`;
    const lane = this.getOrCreateLane(laneKey);
    const text = message.text?.trim() ?? '';

    // --- Gateway-level slash command handling ---

    const cmdToken = text.split(/\s+/)[0] ?? '';
    const cmdType = PLATFORM_COMMANDS[cmdToken.toLowerCase()];

    if (cmdType === 'stop') {
      lane.abort();
      await adapter.send(message.chatId, { text: '✓ Stopped.' }).catch(() => {});
      return;
    }

    if (cmdType === 'new') {
      lane.abort();
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      this.usageStore.delete(laneKey);
      this.personalityIds.delete(laneKey); // reset to default personality
      await adapter.send(message.chatId, { text: '✓ New session started.' }).catch(() => {});
      return;
    }

    if (cmdType === 'help') {
      const current = this.personalityIds.get(laneKey) ?? this.defaultPersonality ?? 'default';
      await adapter
        .send(message.chatId, {
          text:
            `/new — start a fresh session\n` +
            `/stop — abort current response\n` +
            `/personality — show current personality (${current})\n` +
            `/personality list — available personalities\n` +
            `/personality <id> — switch personality\n` +
            `/usage — token and cost stats\n` +
            `/help — this message`,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'personality') {
      const arg = text.split(/\s+/).slice(1).join(' ').trim();
      const current = this.personalityIds.get(laneKey) ?? this.defaultPersonality ?? 'default';

      if (!arg) {
        await adapter
          .send(message.chatId, { text: `Current personality: ${current}` })
          .catch(() => {});
        return;
      }

      if (arg === 'list') {
        await adapter
          .send(message.chatId, {
            text: 'Built-in personalities: researcher · engineer · reviewer · coach · operator\n\nUse /personality <id> to switch.',
          })
          .catch(() => {});
        return;
      }

      // Switch personality — also start a fresh session so the new identity takes effect immediately
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      this.personalityIds.set(laneKey, arg);
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      await adapter
        .send(message.chatId, { text: `✓ Switched to ${arg} personality. New session started.` })
        .catch(() => {});
      return;
    }

    if (cmdType === 'usage') {
      const u = this.usageStore.get(laneKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      await adapter
        .send(message.chatId, {
          text: `Tokens: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out\nCost: $${u.costUsd.toFixed(5)}`,
        })
        .catch(() => {});
      return;
    }

    // --- Agent turn ---

    await lane.enqueue(async (signal) => {
      const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      const personalityId = this.personalityIds.get(laneKey) ?? this.defaultPersonality;

      // Track this turn so graceful shutdown can notify the user (P1-1).
      this.activeTurns.set(laneKey, { adapter, chatId: message.chatId });

      // Typing indicator — renew every 4 s (Telegram shows it for ~5 s)
      await adapter.sendTyping?.(message.chatId).catch(() => {});
      const typingTimer = setInterval(() => {
        void adapter.sendTyping?.(message.chatId).catch(() => {});
      }, 4_000);

      try {
        let responseText = '';
        let errored: { error: string; code: string } | null = null;

        for await (const event of this.loop.run(text, {
          sessionKey,
          personalityId,
          abortSignal: signal,
        })) {
          if (event.type === 'text_delta') responseText += event.text;
          if (event.type === 'usage') {
            const u = this.usageStore.get(laneKey) ?? {
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            };
            u.inputTokens += event.inputTokens;
            u.outputTokens += event.outputTokens;
            u.costUsd += event.estimatedCostUsd;
            this.usageStore.set(laneKey, u);
          }
          if (event.type === 'error') {
            errored = { error: event.error, code: event.code };
            break;
          }
          if (event.type === 'done') break;
        }

        if (signal.aborted) {
          // /stop or shutdown — caller already notified the user.
        } else if (errored) {
          // Surface error explicitly so users don't mistake a partial answer
          // for a complete one. Aborts (code === 'aborted') are silent above.
          const note =
            responseText.trim().length > 0
              ? `${responseText}\n\n⚠ Response interrupted: ${errored.error}`
              : `⚠ Error: ${errored.error}`;
          if (this.outboundDedup.shouldSend(sessionKey, note)) {
            await adapter.send(message.chatId, { text: note }).catch(() => {});
          }
        } else if (responseText) {
          // Outbound dedup — suppress same (sessionId, content) within TTL.
          // Adapters that previously rolled their own dedup go through this
          // cache instead. See plan/phases/30-robustness.md § 30.4.
          if (this.outboundDedup.shouldSend(sessionKey, responseText)) {
            await adapter
              .send(message.chatId, { text: responseText, parseMode: 'markdown' })
              .catch(() => {});
          }
        }
      } finally {
        clearInterval(typingTimer);
        this.activeTurns.delete(laneKey);
      }
    });
  }

  /**
   * Stop all active session lanes gracefully. If `notify` is set, send that
   * text to every chat with an in-flight turn before aborting — so users
   * never see silent failure on shutdown / upgrade. See IMPROVEMENT.md P1-1
   * and OpenClaw #71178 (mid-turn update drops every Telegram message).
   */
  async shutdown(opts: { notify?: string } = {}): Promise<void> {
    if (opts.notify) {
      const sends: Promise<unknown>[] = [];
      for (const ctx of this.activeTurns.values()) {
        sends.push(ctx.adapter.send(ctx.chatId, { text: opts.notify }).catch(() => {}));
      }
      await Promise.allSettled(sends);
    }
    for (const lane of this.lanes.values()) {
      lane.abort();
    }
    this.lanes.clear();
    this.sessionKeys.clear();
    this.activeTurns.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getOrCreateLane(key: string): SessionLane {
    const existing = this.lanes.get(key);
    if (existing) {
      // LRU touch: re-insert to push to the tail so eviction skips it.
      this.lanes.delete(key);
      this.lanes.set(key, existing);
      return existing;
    }
    const lane = new SessionLane();
    this.lanes.set(key, lane);
    this.evictIdleChats();
    return lane;
  }

  /**
   * Bound per-chat state at `maxChats`. Walks `lanes` in LRU order (oldest
   * first) and evicts the first idle chat — one whose lane queue is empty
   * and that has no in-flight turn. Active chats are skipped, so a flood of
   * new chats can't drop a user mid-response.
   */
  private evictIdleChats(): void {
    while (this.lanes.size > this.maxChats) {
      let evictedKey: string | null = null;
      for (const [key, lane] of this.lanes) {
        if (lane.length === 0 && !this.activeTurns.has(key)) {
          evictedKey = key;
          break;
        }
      }
      if (evictedKey === null) return; // every chat is busy — leave the cap alone
      this.lanes.delete(evictedKey);
      this.sessionKeys.delete(evictedKey);
      this.personalityIds.delete(evictedKey);
      this.usageStore.delete(evictedKey);
    }
  }
}
