import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { Bot } from 'grammy';

// ---------------------------------------------------------------------------
// Text chunking — Telegram has a 4096 char limit per message
// ---------------------------------------------------------------------------

export function chunkText(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer breaking at a newline, then a space
    let cutAt = maxLength;
    const newlineAt = remaining.lastIndexOf('\n', maxLength);
    if (newlineAt > maxLength * 0.6) {
      cutAt = newlineAt + 1;
    } else {
      const spaceAt = remaining.lastIndexOf(' ', maxLength);
      if (spaceAt > maxLength * 0.6) cutAt = spaceAt + 1;
    }

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
// TelegramAdapter
// ---------------------------------------------------------------------------

export interface TelegramAdapterConfig {
  token: string;
  /** Whether to drop updates that arrived while the bot was offline. Default true. */
  dropPendingUpdates?: boolean;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly id = 'telegram';
  readonly displayName = 'Telegram';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 4096;

  private readonly bot: Bot;
  private readonly dropPendingUpdates: boolean;
  private messageHandler?: (message: InboundMessage) => void;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  constructor(config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
    this.dropPendingUpdates = config.dropPendingUpdates ?? true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.bot.on('message', (ctx) => {
      if (!this.messageHandler) return;

      const text = ctx.message.text ?? ctx.message.caption ?? '';
      if (!text) return;

      const msg: InboundMessage = {
        platform: 'telegram',
        chatId: String(ctx.chat.id),
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isDm: ctx.chat.type === 'private',
        isGroupMention: ctx.message.text?.includes(`@${ctx.me.username}`) ?? false,
        messageId: String(ctx.message.message_id),
        raw: ctx,
      };

      this.messageHandler(msg);
    });

    // Non-blocking: bot.start() runs the polling loop in the background
    void this.bot.start({ drop_pending_updates: this.dropPendingUpdates });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const chunks = chunkText(message.text, this.maxMessageLength);
    const ids: string[] = [];

    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), chunk, {
          parse_mode: message.parseMode === 'html' ? 'HTML' : 'Markdown',
          reply_parameters: message.replyToId
            ? { message_id: Number(message.replyToId) }
            : undefined,
        });
        ids.push(String(sent.message_id));
      } catch (err) {
        // Markdown parse errors — retry as plain text
        if (String(err).includes('parse')) {
          const sent = await this.bot.api.sendMessage(Number(chatId), chunk).catch(() => null);
          if (sent) ids.push(String(sent.message_id));
        } else {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    this.rememberChunkIds(ids);
    return { ok: true, messageId: ids[0] };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          await this.bot.api.editMessageText(Number(chatId), Number(id), chunk, {
            parse_mode: 'Markdown',
          });
          return id;
        },
        append: async (chunk) => {
          const sent = await this.bot.api.sendMessage(Number(chatId), chunk, {
            parse_mode: 'Markdown',
          });
          return String(sent.message_id);
        },
        deleteId: async (id) => {
          await this.bot.api.deleteMessage(Number(chatId), Number(id));
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
    const start = Date.now();
    try {
      await this.bot.api.getMe();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }
}
