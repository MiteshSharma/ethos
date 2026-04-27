import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { App, type MessageEvent } from '@slack/bolt';

// ---------------------------------------------------------------------------
// Text chunking — Slack 4000 char limit per block
// ---------------------------------------------------------------------------

export function chunkText(text: string, maxLength = 3000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const newline = remaining.lastIndexOf('\n', maxLength);
    const cutAt = newline > maxLength * 0.6 ? newline + 1 : maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }

  return chunks;
}

/**
 * Re-flow `newChunks` over `existingIds`. Edits the first N chunks in place,
 * appends extras, and deletes trailing existing chunks no longer needed.
 * Delete failures are swallowed (best-effort).
 */
export async function reflowChunks(
  newChunks: string[],
  existingIds: string[],
  ops: {
    edit: (id: string, text: string) => Promise<string>;
    append: (text: string) => Promise<string>;
    deleteId: (id: string) => Promise<void>;
  },
): Promise<string[]> {
  const updated: string[] = [];
  for (let i = 0; i < newChunks.length; i++) {
    if (i < existingIds.length) {
      updated.push(await ops.edit(existingIds[i], newChunks[i]));
    } else {
      updated.push(await ops.append(newChunks[i]));
    }
  }
  for (let i = newChunks.length; i < existingIds.length; i++) {
    try {
      await ops.deleteId(existingIds[i]);
    } catch {
      // best-effort delete
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// SlackAdapter
// ---------------------------------------------------------------------------

export interface SlackAdapterConfig {
  /** Bot token (xoxb-...) */
  botToken: string;
  /** App-level token for socket mode (xapp-...) */
  appToken: string;
  /** Signing secret from Slack app config */
  signingSecret: string;
}

export class SlackAdapter implements PlatformAdapter {
  readonly id = 'slack';
  readonly displayName = 'Slack';
  readonly canSendTyping = false; // Slack doesn't support persistent typing indicator
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 3000;

  private readonly app: App;
  private readonly client: App['client'];
  private messageHandler?: (message: InboundMessage) => void;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  constructor(config: SlackAdapterConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true, // no public URL needed — like Telegram's long-polling
    });

    this.client = this.app.client;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // DMs and direct messages to the bot
    this.app.message(async ({ message, say: _say }) => {
      if (!this.messageHandler) return;
      const msg = message as MessageEvent;
      if (msg.subtype) return; // skip bot messages, edits, etc.

      const text = 'text' in msg && msg.text ? msg.text.trim() : '';
      if (!text) return;

      const channelType = 'channel_type' in msg ? String(msg.channel_type) : 'unknown';
      const isDm = channelType === 'im';

      const ts = 'ts' in msg ? String(msg.ts) : undefined;
      this.messageHandler({
        platform: 'slack',
        chatId: String(msg.channel),
        userId: 'user' in msg ? String(msg.user) : undefined,
        text,
        isDm,
        isGroupMention: false,
        replyToId: ts,
        messageId: ts,
        raw: msg,
      });
    });

    // @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      if (!this.messageHandler) return;
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      this.messageHandler({
        platform: 'slack',
        chatId: event.channel,
        userId: event.user,
        text,
        isDm: false,
        isGroupMention: true,
        replyToId: event.ts,
        messageId: event.ts,
        raw: event,
      });
    });

    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const chunks = chunkText(message.text, this.maxMessageLength);
      const ids: string[] = [];

      for (const chunk of chunks) {
        const result = await this.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          // Reply in thread if replyToId is set
          ...(message.replyToId ? { thread_ts: message.replyToId } : {}),
          mrkdwn: true,
        });
        const ts = result.ts as string | undefined;
        if (ts) ids.push(ts);
      }

      this.rememberChunkIds(ids);
      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (ts, chunk) => {
          await this.client.chat.update({ channel: chatId, ts, text: chunk });
          return ts;
        },
        append: async (chunk) => {
          const result = await this.client.chat.postMessage({
            channel: chatId,
            text: chunk,
            mrkdwn: true,
          });
          return (result.ts as string | undefined) ?? '';
        },
        deleteId: async (ts) => {
          await this.client.chat.delete({ channel: chatId, ts });
        },
      });

      this.chunkMap.delete(messageId);
      this.rememberChunkIds(updatedIds);
      return { ok: true, messageId: updatedIds[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private rememberChunkIds(ids: string[]): void {
    if (ids.length === 0) return;
    const primary = ids[0];
    while (this.chunkMap.size >= this.chunkMapMaxEntries && !this.chunkMap.has(primary)) {
      const oldestKey = this.chunkMap.keys().next().value;
      if (oldestKey === undefined) break;
      this.chunkMap.delete(oldestKey);
    }
    this.chunkMap.set(primary, ids);
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    try {
      const start = Date.now();
      await this.client.auth.test();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }
}
