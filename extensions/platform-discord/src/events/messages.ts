import type { Attachment, AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import type { ChannelMode } from '../config';
import type { TriageContext } from '../routing/triage';
import { triageMessage } from '../routing/triage';
import type { BackfillStateStore } from '../store/backfill-state';
import type { ChannelOverrideStore } from '../store/channel-overrides';
import type { ThreadStateStore } from '../store/thread-state';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** Known Discord CDN hosts for attachment downloads. */
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/**
 * Audio uploads are classified as `type: 'audio'` so channel STT transcribes
 * them — a Discord voice message arrives as `audio/ogg` / `.ogg`. `webm` is
 * deliberately absent: it carries either audio or video and is overwhelmingly
 * video on Discord, the same call the Slack adapter made.
 */
const AUDIO_CONTENT_TYPES = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/aac',
]);
const AUDIO_EXTS = new Set(['ogg', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'opus']);
const SKIP_EXTS = new Set(['exe', 'dll', 'so', 'dylib']);

/** Turn text used when an attachment arrives with no message body. */
const MEDIA_PLACEHOLDER: Record<Attachment['type'], string> = {
  image: '(attached image)',
  file: '(attached file)',
  audio: '(voice message)',
};

/** Debounce window for edit events (ms). */
const EDIT_DEBOUNCE_MS = 200;

interface MessageContext {
  client: Client;
  botKey: string;
  defaultChannelMode: ChannelMode;
  receiptReaction: string;
  cache?: AttachmentCache;
  channelOverrides?: ChannelOverrideStore;
  threadState?: ThreadStateStore;
  backfillState?: BackfillStateStore;
  onMessage: (msg: InboundMessage) => void;
  onReceipt: (channelId: string, messageId: string) => void;
}

export function registerMessageHandler(ctx: MessageContext): void {
  ctx.client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const envelope = await buildMessageEnvelope(message, ctx, false);
    if (!envelope) return;

    // Channel history backfill — first encounter in this lane
    if (ctx.backfillState) {
      const bfChatId = message.channel.isThread()
        ? (message.channel.parentId ?? message.channelId)
        : message.channelId;
      const bfThreadId = message.channel.isThread() ? message.channelId : undefined;
      if (!ctx.backfillState.hasDone(bfChatId, bfThreadId)) {
        const priorContext = await fetchChannelHistory(message);
        await ctx.backfillState.mark(bfChatId, bfThreadId);
        if (priorContext) {
          envelope.priorContext = priorContext;
        }
      }
    }

    // Receipt reaction (best-effort, non-blocking)
    if (ctx.receiptReaction) {
      message.react(ctx.receiptReaction).catch(() => {});
      ctx.onReceipt(message.channelId, message.id);
    }

    if (message.attachments.size === 0 || !ctx.cache) {
      ctx.onMessage(envelope);
      return;
    }

    const attachments = await downloadAttachments(message, ctx.cache);
    if (attachments.length > 0) {
      envelope.attachments = attachments;
      if (!envelope.text) {
        envelope.text = MEDIA_PLACEHOLDER[attachments[0].type];
      }
    }
    ctx.onMessage(envelope);
  });
}

/**
 * Registers a `messageUpdate` listener that debounces rapid edits and
 * re-triages the updated message with `isEdit: true`.
 */
export function registerEditHandler(ctx: MessageContext): void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  ctx.client.on('messageUpdate', async (_oldMessage, newMessage) => {
    // Partials: fetch full message when needed
    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch {
        return;
      }
    }

    if (newMessage.author?.bot) return;

    // Discord fires messageUpdate for embed hydration, pin changes, flag
    // updates, etc. Only process events where user-visible content changed.
    const oldContent = _oldMessage.partial ? undefined : _oldMessage.content;
    if (oldContent !== undefined && oldContent === newMessage.content) return;

    const debounceKey = `${newMessage.channelId}:${newMessage.id}`;
    const existing = pending.get(debounceKey);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(debounceKey);
      void (async () => {
        try {
          const envelope = await buildMessageEnvelope(newMessage as Message, ctx, true);
          if (!envelope) return;
          ctx.onMessage(envelope);
        } catch {
          // Best-effort — matches adapter error policy for messageCreate
        }
      })();
    }, EDIT_DEBOUNCE_MS);

    pending.set(debounceKey, timer);
  });
}

/**
 * Shared logic: triage a Discord message into an InboundMessage envelope.
 * Returns `undefined` when the message should be dropped.
 */
async function buildMessageEnvelope(
  message: Message,
  ctx: MessageContext,
  isEdit: boolean,
): Promise<InboundMessage | undefined> {
  const isDm = message.channel.isDMBased();
  const isMention = ctx.client.user
    ? message.mentions.has(ctx.client.user) && !message.mentions.everyone
    : false;
  const isThread = message.channel.isThread();

  let text = message.content;
  if (ctx.client.user) {
    text = text.replace(new RegExp(`<@!?${ctx.client.user.id}>`, 'g'), '').trim();
  }

  const triageCtx: TriageContext = {
    botKey: ctx.botKey,
    defaultChannelMode: ctx.defaultChannelMode,
    channelOverrides: ctx.channelOverrides,
    threadState: ctx.threadState,
  };

  const result = await triageMessage(
    {
      channelId: message.channelId,
      userId: message.author.id,
      username: message.author.username,
      text,
      messageId: message.id,
      isDm,
      isThread,
      threadId: isThread ? message.channelId : undefined,
      parentChannelId: isThread ? (message.channel.parentId ?? undefined) : undefined,
      isMention: isMention && !isDm,
      reference: {
        messageId: message.reference?.messageId ?? undefined,
        userId: message.mentions.repliedUser?.id ?? undefined,
      },
      raw: message,
    },
    triageCtx,
  );

  if (!result.envelope) return undefined;

  const envelope = result.envelope;

  if (isEdit) {
    envelope.isEdit = true;
  }

  // Populate replyToId/replyToUserId from the reference
  if (message.reference?.messageId) {
    envelope.replyToId = message.reference.messageId;
  }
  if (message.mentions.repliedUser?.id) {
    envelope.replyToUserId = message.mentions.repliedUser.id;
  }

  return envelope;
}

/** Exported for testing — the classification the STT gate depends on. */
export function classifyAttachmentType(
  contentType: string | null,
  filename: string | undefined,
): Attachment['type'] {
  // Trust contentType first when available
  if (contentType && IMAGE_CONTENT_TYPES.has(contentType)) return 'image';
  if (contentType && AUDIO_CONTENT_TYPES.has(contentType)) return 'audio';
  // Fall back to extension
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

async function downloadAttachments(
  message: Message,
  cache: AttachmentCache,
): Promise<Attachment[]> {
  const results: Attachment[] = [];

  for (const [, attachment] of message.attachments) {
    if (attachment.size > MAX_FILE_SIZE) continue;

    const ext = attachment.name?.split('.').pop()?.toLowerCase() ?? '';
    if (SKIP_EXTS.has(ext)) continue;

    const mimeType = attachment.contentType ?? 'application/octet-stream';
    const type = classifyAttachmentType(attachment.contentType, attachment.name ?? undefined);

    try {
      // SSRF gate: only fetch from known Discord CDN hosts
      let attachmentHost: string;
      try {
        attachmentHost = new URL(attachment.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!DISCORD_CDN_HOSTS.has(attachmentHost)) continue;

      // Use redirect: 'error' — Discord CDN responses should not redirect;
      // refusing redirects eliminates the SSRF-via-redirect vector.
      let attachResp: Response;
      try {
        attachResp = await fetch(attachment.url, { redirect: 'error' });
      } catch {
        continue;
      }
      if (!attachResp.ok) continue;
      const buffer = Buffer.from(await attachResp.arrayBuffer());
      const filename = attachment.name ?? 'attachment';
      const url = await cache.write(buffer, {
        sessionKey: '',
        messageId: message.id,
        filename,
        mime: mimeType,
      });
      results.push({
        type,
        ref: attachment.url,
        url,
        mimeType,
        filename,
        sizeBytes: buffer.length,
      });
    } catch {
      // best-effort download
    }
  }

  return results;
}

const BACKFILL_FETCH_LIMIT = 50;
const BACKFILL_INCLUDE_LIMIT = 40;
const BACKFILL_CHAR_LIMIT = 4000;

async function fetchChannelHistory(message: Message): Promise<string | undefined> {
  try {
    const fetched = await message.channel.messages.fetch({
      limit: BACKFILL_FETCH_LIMIT,
      before: message.id,
    });
    if (fetched.size === 0) return undefined;

    const lines = [...fetched.values()]
      .reverse()
      .filter((m) => m.content.trim() && !m.author.bot)
      .slice(-BACKFILL_INCLUDE_LIMIT)
      .map((m) => `${m.author.username}: ${m.content.trim()}`)
      .join('\n');

    if (!lines) return undefined;

    const trimmed =
      lines.length > BACKFILL_CHAR_LIMIT
        ? `[... earlier messages omitted]\n${lines.slice(-BACKFILL_CHAR_LIMIT)}`
        : lines;

    return `[Recent channel history — ${fetched.size} messages before bot joined]\n\n${trimmed}`;
  } catch {
    return undefined;
  }
}
