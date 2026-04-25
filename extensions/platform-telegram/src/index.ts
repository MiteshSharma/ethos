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
    let lastMessageId: string | undefined;

    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), chunk, {
          parse_mode: message.parseMode === 'html' ? 'HTML' : 'Markdown',
          reply_parameters: message.replyToId
            ? { message_id: Number(message.replyToId) }
            : undefined,
        });
        lastMessageId = String(sent.message_id);
      } catch (err) {
        // Markdown parse errors — retry as plain text
        if (String(err).includes('parse')) {
          const sent = await this.bot.api.sendMessage(Number(chatId), chunk).catch(() => null);
          if (sent) lastMessageId = String(sent.message_id);
        } else {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    return { ok: true, messageId: lastMessageId };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, {
        parse_mode: 'Markdown',
      });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
