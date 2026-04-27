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

/**
 * Re-flow `newChunks` over `existingIds`. Edits the first N chunks in place,
 * appends extras, and deletes trailing existing chunks no longer needed.
 * Delete failures are swallowed (best-effort) — they shouldn't block an edit.
 * Returns the new ordered chunk ids.
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
  /**
   * Chunk-id ledger so `editMessage` can re-flow multi-chunk responses.
   * Keyed by the primary (first) chunk id, value = ordered list of all
   * chunk ids in the response. Bounded to `chunkMapMaxEntries` with FIFO
   * eviction so long-running bots don't grow unbounded.
   */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

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
        messageId: message.id,
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
      const ids: string[] = [];

      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union excludes PartialGroupDM
        const sent = await (channel as any).send({ content: chunk });
        ids.push(String(sent.id));
      }

      this.rememberChunkIds(ids);
      return { ok: true, messageId: ids[0] };
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
      if (!channel || !('messages' in channel) || !('send' in channel)) {
        return { ok: false, error: 'Channel not found' };
      }

      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(id);
          const edited = await msg.edit(chunk);
          return String(edited.id);
        },
        append: async (chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const sent = await (channel as any).send({ content: chunk });
          return String(sent.id);
        },
        deleteId: async (id) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(id);
          await msg.delete();
        },
      });

      // Re-key the map under the (possibly new) first id, drop the old key
      // when it changed, so future edits still resolve.
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
    return {
      ok: this.client.ws.status === 0,
      latencyMs: this.client.ws.ping,
    };
  }
}
