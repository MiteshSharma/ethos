import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';

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

  constructor(config: GatewayConfig) {
    this.loop = config.loop;
    this.defaultPersonality = config.defaultPersonality;
  }

  // ---------------------------------------------------------------------------
  // Public API — adapters call this for every inbound message
  // ---------------------------------------------------------------------------

  async handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void> {
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

      // Typing indicator — renew every 4 s (Telegram shows it for ~5 s)
      await adapter.sendTyping?.(message.chatId).catch(() => {});
      const typingTimer = setInterval(() => {
        void adapter.sendTyping?.(message.chatId).catch(() => {});
      }, 4_000);

      try {
        let responseText = '';

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
          if (event.type === 'error' || event.type === 'done') break;
        }

        if (responseText && !signal.aborted) {
          await adapter
            .send(message.chatId, { text: responseText, parseMode: 'markdown' })
            .catch(() => {});
        }
      } finally {
        clearInterval(typingTimer);
      }
    });
  }

  /** Stop all active session lanes gracefully. */
  async shutdown(): Promise<void> {
    for (const lane of this.lanes.values()) {
      lane.abort();
    }
    this.lanes.clear();
    this.sessionKeys.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getOrCreateLane(key: string): SessionLane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new SessionLane();
      this.lanes.set(key, lane);
    }
    return lane;
  }
}
