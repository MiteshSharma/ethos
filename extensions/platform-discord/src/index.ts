import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { Client, Events, GatewayIntentBits, type Message, Partials } from 'discord.js';

// ---------------------------------------------------------------------------
// Text chunking — Discord 2000 char limit
// ---------------------------------------------------------------------------

export function chunkText(text: string, maxLength = 2000): string[] {
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

// ---------------------------------------------------------------------------
// DiscordAdapter
// ---------------------------------------------------------------------------

export interface DiscordAdapterConfig {
  token: string;
  /**
   * When true (default), the bot only responds in DMs and when @mentioned.
   * Set to false to respond to every message the bot can see.
   */
  mentionOnly?: boolean;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly id = 'discord';
  readonly displayName = 'Discord';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 2000;

  private readonly client: Client;
  private readonly token: string;
  private readonly mentionOnly: boolean;
  private messageHandler?: (message: InboundMessage) => void;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.mentionOnly = config.mentionOnly ?? true;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // requires privileged intent in dev portal
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (!this.messageHandler) return;
      if (message.author.bot) return;

      const isDm = message.channel.isDMBased();
      const isMention = this.client.user ? message.mentions.has(this.client.user) : false;

      // In servers, only respond when @mentioned (unless mentionOnly=false)
      if (!isDm && this.mentionOnly && !isMention) return;

      // Strip the @mention prefix from the message text
      let text = message.content;
      if (this.client.user) {
        text = text.replace(`<@${this.client.user.id}>`, '').trim();
      }

      const msg: InboundMessage = {
        platform: 'discord',
        chatId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        text,
        isDm,
        isGroupMention: isMention && !isDm,
        replyToId: message.id,
        raw: message,
      };

      this.messageHandler(msg);
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable' };
      }

      const chunks = chunkText(message.text, this.maxMessageLength);
      let lastId: string | undefined;

      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union excludes PartialGroupDM
        const sent = await (channel as any).send({ content: chunk });
        lastId = String(sent.id);
      }

      return { ok: true, messageId: lastId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'sendTyping' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        await (channel as any).sendTyping();
      }
    } catch {
      // ignore
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('messages' in channel)) return { ok: false, error: 'Channel not found' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const msg = await (channel as any).messages.fetch(messageId);
      const edited = await msg.edit(text.slice(0, this.maxMessageLength));
      return { ok: true, messageId: String(edited.id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return {
      ok: this.client.ws.status === 0,
      latencyMs: this.client.ws.ping,
    };
  }
}
