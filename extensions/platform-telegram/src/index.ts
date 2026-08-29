import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type {
  AdapterCapabilities,
  AdapterVoiceCaps,
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  Attachment,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SendVoiceNoteOptions,
  Storage,
  VoiceOutboundAdapter,
} from '@ethosagent/types';
import { Bot, InlineKeyboard, InputFile, webhookCallback } from 'grammy';
import { type ChannelMode, DEFAULT_CHANNEL_MODE } from './config';
import { chunkHash, markdownToTelegramHtml } from './format';
import { shouldRespond } from './routing/channel-mode';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';

// ---------------------------------------------------------------------------
// Clarify interactive shapes — used by the Telegram clarify surface to post
// inline-keyboard prompts and force-reply prompts. Defined here so the
// surface module depends on a structural shape on the adapter rather than
// reaching into grammy itself.
// ---------------------------------------------------------------------------

/** One button in an inline keyboard row. */
export interface InlineButton {
  label: string;
  /** Telegram `callback_data` — must be 1..64 bytes UTF-8. */
  data: string;
}

/** Inbound callback-query event surfaced to the clarify surface. */
export interface CallbackQueryEvent {
  /** Telegram callback_query id — used to dismiss the spinner. */
  queryId: string;
  data: string;
  chatId: string;
  /** Message id of the keyboard the user tapped (the prompt). */
  messageId: string;
  userId: string | undefined;
  username: string | undefined;
  /** Dismiss the loading spinner on the button. Idempotent best-effort. */
  answer: (text?: string) => Promise<void>;
}

// grammy's ReactionTypeEmoji.emoji is a strict union of specific emoji
// literals. We define a type alias so config strings can be cast cleanly.
type TelegramEmoji = '👀';

// ---------------------------------------------------------------------------
// Truncation utility — BotFather fields have strict char limits
// ---------------------------------------------------------------------------

export function truncateWithEllipsis(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

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
// Media helpers — detect + download inbound file attachments
// ---------------------------------------------------------------------------

/** Maximum file size in bytes that we'll download into memory. */
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

interface MediaDescriptor {
  fileId: string;
  type: Attachment['type'];
  mimeType: string;
  filename?: string;
  fileSize?: number;
}

/** Map Telegram media type placeholders for captionless messages. */
const MEDIA_PLACEHOLDER: Record<Attachment['type'], string> = {
  image: '(attached image)',
  file: '(attached file)',
  audio: '(voice message)',
};

/**
 * Extract media descriptors from a Telegram message object.
 * Photo → image, document → file, voice/audio → audio.
 * Video, animation, and sticker are intentionally dropped —
 * the inbound caption still reaches the agent, just no attachment is created.
 * Returns an empty array when the message has no supported media.
 */
function extractMedia(msg: Record<string, unknown>): MediaDescriptor[] {
  const results: MediaDescriptor[] = [];

  // photo → array of PhotoSize; pick the last (highest resolution)
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1] as Record<string, unknown>;
    results.push({
      fileId: String(largest.file_id),
      type: 'image',
      mimeType: 'image/jpeg',
      fileSize: typeof largest.file_size === 'number' ? largest.file_size : undefined,
    });
  }

  // document
  if (msg.document && typeof msg.document === 'object') {
    const doc = msg.document as Record<string, unknown>;
    results.push({
      fileId: String(doc.file_id),
      type: 'file',
      mimeType: typeof doc.mime_type === 'string' ? doc.mime_type : 'application/octet-stream',
      filename: typeof doc.file_name === 'string' ? doc.file_name : undefined,
      fileSize: typeof doc.file_size === 'number' ? doc.file_size : undefined,
    });
  }

  // voice note (audio/ogg with OPUS codec)
  if (msg.voice && typeof msg.voice === 'object') {
    const voice = msg.voice as Record<string, unknown>;
    results.push({
      fileId: String(voice.file_id),
      type: 'audio' as Attachment['type'],
      mimeType: 'audio/ogg',
      fileSize: typeof voice.file_size === 'number' ? voice.file_size : undefined,
    });
  }

  // audio file (e.g. MP3, forwarded music)
  if (msg.audio && typeof msg.audio === 'object') {
    const audio = msg.audio as Record<string, unknown>;
    results.push({
      fileId: String(audio.file_id),
      type: 'audio' as Attachment['type'],
      mimeType: typeof audio.mime_type === 'string' ? audio.mime_type : 'audio/mpeg',
      filename: typeof audio.file_name === 'string' ? audio.file_name : undefined,
      fileSize: typeof audio.file_size === 'number' ? audio.file_size : undefined,
    });
  }

  return results;
}

/**
 * Download a single file from the Telegram Bot API. Returns a Buffer on
 * success, null on failure. Best-effort — callers handle the null case.
 */
export async function downloadTelegramFile(
  botApi: { getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }> },
  token: string,
  descriptor: MediaDescriptor,
): Promise<{ data: Buffer; fileSize: number } | null> {
  try {
    const fileInfo = await botApi.getFile(descriptor.fileId);
    const fileSize = fileInfo.file_size ?? descriptor.fileSize ?? 0;

    if (fileSize > MAX_FILE_SIZE) return null;

    if (!fileInfo.file_path) return null;

    const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;

    const arrayBuf = await resp.arrayBuffer();
    // Post-download guard: the pre-check trusts the *declared* size, which is
    // `0` (and thus passes) when Telegram omits `file_size`. Re-check the
    // actual byte length so an undeclared-size file can't bypass the cap.
    if (arrayBuf.byteLength > MAX_FILE_SIZE) return null;
    return { data: Buffer.from(arrayBuf), fileSize };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export interface TelegramAdapterConfig {
  token: string;
  /**
   * Attachment cache used to persist downloaded media as `file://` URLs.
   * Required — inbound photo/document attachments are written here.
   */
  cache: AttachmentCache;
  /**
   * Stable identifier of the bot this adapter is bound to. Stamped on every
   * inbound `InboundMessage.botKey` so the Gateway can route to the right
   * `AgentLoop` in multi-bot deployments. Required — computed once in wiring
   * (`deriveBotKey`); the adapter no longer derives its own key, so the
   * routing identity has a single source of truth.
   */
  botKey: string;
  /** Whether to drop updates that arrived while the bot was offline. Default true. */
  dropPendingUpdates?: boolean;
  /**
   * Bot identity pushed to BotFather at start(). Personality-bound bots
   * populate this from the personality config so the Telegram profile
   * reflects the agent's name and description. Best-effort — failures
   * are swallowed. Omit for team bindings (don't change BotFather settings).
   */
  identity?: {
    name: string;
    shortDescription: string;
    description: string;
  };
  /**
   * Emoji reaction set on inbound messages to acknowledge receipt.
   * Cleared when the agent's reply lands. Default '👀'.
   */
  receiptReaction?: string;
  /**
   * How long after the original message an edit is still accepted for
   * re-processing (milliseconds). Edits outside this window are ignored.
   * Default 60 000 (60 seconds).
   */
  editWindowMs?: number;
  /**
   * Outbound parse mode. `'html'` (default) translates agent Markdown to
   * Telegram HTML. `'plain'` skips translation and HTML escaping entirely.
   */
  parseMode?: 'html' | 'plain';
  /**
   * Storage backend for JSONL-based persistence (channel overrides,
   * thread state). When omitted, no persistence is available — the
   * adapter operates statelessly.
   */
  storage?: Storage;
  /**
   * Base directory name under the Storage root for Telegram data files.
   * Default `'telegram'`. The final path is `<telegramDir>/<botKey>/`.
   */
  telegramDir?: string;
  /**
   * Default channel mode for groups. Per-channel overrides take precedence.
   * Default `'mention_only'`.
   */
  defaultChannelMode?: ChannelMode;
  /**
   * Enable webhook mode instead of long-polling. Requires `webhookUrl`.
   * When enabled, the adapter registers the webhook with Telegram and
   * exposes a `webhook` getter for the host app to mount on an HTTP route.
   */
  useWebhook?: boolean;
  /**
   * Public URL that Telegram should POST updates to. Required when
   * `useWebhook` is true.
   */
  webhookUrl?: string;
  /**
   * Secret token for webhook request verification. When set, Telegram sends
   * this value in the `X-Telegram-Bot-Api-Secret-Token` header; the adapter
   * validates it before processing updates. Required when `useWebhook` is true.
   */
  webhookSecretToken?: string;
}

/**
 * Resolve an outbound `Attachment` into a grammy `InputFile`. `url` is either
 * a `data:<mime>;base64,<...>` URI (inline bytes) or a local filesystem path,
 * per the W3.2 outbound-media convention.
 */
function toTelegramInputFile(att: Attachment): InputFile {
  const m = att.url.match(/^data:[^;,]+;base64,(.*)$/s);
  const name = att.filename ?? att.ref;
  if (m?.[1] !== undefined) {
    return new InputFile(Buffer.from(m[1], 'base64'), name);
  }
  // Local path — grammy streams it lazily.
  return new InputFile(att.url, name);
}

export class TelegramAdapter
  implements PlatformAdapter, ApprovalCapableAdapter, VoiceOutboundAdapter
{
  readonly id: string;
  readonly displayName = 'Telegram';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = true;
  readonly maxMessageLength = 4096;

  /**
   * Declared voice capabilities. `opus` leads the outbound list because
   * `sendVoice` with Ogg/Opus bytes is what makes Telegram render a playable
   * voice bubble; anything else degrades to `sendAudio` (still playable, but
   * an audio card rather than a bubble).
   */
  readonly voiceCaps: AdapterVoiceCaps = {
    inbound: ['opus', 'ogg', 'mp3', 'm4a'],
    outbound: {
      formats: ['opus', 'ogg', 'mp3'],
      kind: 'voice_note',
      maxBytes: 50 * 1024 * 1024,
    },
  };

  get capabilities(): AdapterCapabilities {
    return {
      platform: 'telegram',
      typing: true,
      editDetection: true,
      replyToThreading: true,
      persistence: !!this.channelOverrides,
      channelModes: !!this.channelOverrides,
      outboundFiles: true,
      webhookMode: !!this.config.useWebhook,
    };
  }

  readonly botKey: string;
  private readonly bot: Bot;
  private readonly cache: AttachmentCache;
  private readonly config: TelegramAdapterConfig;
  private readonly dropPendingUpdates: boolean;
  private readonly identity: TelegramAdapterConfig['identity'];
  private readonly receiptReaction: string;
  private readonly parseMode: 'html' | 'plain';
  private messageHandler?: (message: InboundMessage) => void;
  /** Registered by the clarify surface to receive inline-keyboard taps. */
  private callbackQueryHandler?: (event: CallbackQueryEvent) => void;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;
  /** Tracks inbound message ids per chat for reaction clearing on reply. */
  private readonly pendingReactions = new Map<string, number>();
  private readonly editWindowMs: number;
  /** Anti-thrashing debounce timers for edited_message, keyed by messageId. */
  private readonly editDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** JSONL-backed channel mode overrides (Gap 4). */
  private readonly channelOverrides?: ChannelOverrideStore;
  /** JSONL-backed thread-follow tracking (Gap 4). */
  private readonly threadState?: ThreadStateStore;
  /** Webhook callback for external HTTP server wiring (Gap 6). */
  private webhookCb?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  constructor(config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
    this.cache = config.cache;
    this.config = config;
    this.dropPendingUpdates = config.dropPendingUpdates ?? true;
    this.botKey = config.botKey;
    this.identity = config.identity;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.editWindowMs = config.editWindowMs ?? 60_000;
    this.parseMode = config.parseMode ?? 'html';
    // Multi-bot logs disambiguate by including the botKey. Single-bot
    // deployments still pass a botKey (computed once in wiring) and see
    // `telegram:<key>` — the shape is identical, the value carries the
    // routing identity.
    this.id = `telegram:${this.botKey}`;

    // --- Persistence stores (Gap 4) ---
    if (config.storage) {
      const baseDir = join(config.telegramDir ?? 'telegram', this.botKey);
      this.channelOverrides = new ChannelOverrideStore(config.storage, baseDir);
      this.threadState = new ThreadStateStore(config.storage, baseDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // --- Bot identity from personality (best-effort) ---
    if (this.identity) {
      const id = this.identity;
      await this.bot.api.setMyName(truncateWithEllipsis(id.name, 64)).catch(() => {});
      await this.bot.api
        .setMyShortDescription(truncateWithEllipsis(id.shortDescription, 120))
        .catch(() => {});
      await this.bot.api
        .setMyDescription(truncateWithEllipsis(id.description, 512))
        .catch(() => {});
    }

    // --- Commands menu (best-effort) ---
    await this.bot.api
      .setMyCommands([
        { command: 'start', description: 'Introduce the bot' },
        { command: 'new', description: 'Start a fresh session' },
        { command: 'help', description: 'Show available commands' },
        { command: 'personality', description: 'Show the bound personality' },
        { command: 'usage', description: 'Session tokens + cost' },
        { command: 'stop', description: 'Abort the current reply' },
      ])
      .catch(() => {});

    // --- Load persistence stores (Gap 4) ---
    await this.channelOverrides?.load();
    await this.threadState?.load();

    this.bot.on('message', (ctx) => {
      if (!this.messageHandler) return;

      const rawMsg = ctx.message as unknown as Record<string, unknown>;
      const media = extractMedia(rawMsg);
      const caption = (ctx.message.text ?? ctx.message.caption ?? '') as string;
      const hasMedia = media.length > 0;

      // A message with neither text nor media is unprocessable.
      if (!caption && !hasMedia) return;

      // For captionless media messages, use a type-appropriate placeholder.
      const text = caption || (hasMedia ? MEDIA_PLACEHOLDER[media[0].type] : '');

      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;

      // --- Forum-mode topic isolation (3.2) ---
      const rawThreadId =
        typeof rawMsg.message_thread_id === 'number' ? rawMsg.message_thread_id : undefined;
      // General topic (id 1) is treated as no thread for backward compat.
      const threadId =
        rawThreadId !== undefined && rawThreadId !== 1 ? String(rawThreadId) : undefined;

      // --- Channel-mode gating (Gap 5) ---
      const isDm = ctx.chat.type === 'private';
      const isGroupMention = ctx.message.text?.includes(`@${ctx.me.username}`) ?? false;
      const chatIdStr = String(chatId);
      const override = this.channelOverrides?.get(chatIdStr);
      const channelMode: ChannelMode =
        override?.mode ?? this.config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
      const hasBotPosted =
        threadId !== undefined && this.threadState !== undefined
          ? this.threadState.hasBotPosted(chatIdStr, threadId)
          : false;

      if (
        !shouldRespond({
          isDm,
          isGroupMention,
          channelMode,
          hasBotPosted,
          messageText: text,
          regexPattern: override?.regexPattern,
        })
      ) {
        return;
      }

      // --- Reaction on receipt (best-effort, non-blocking) ---
      const reaction = [{ type: 'emoji' as const, emoji: this.receiptReaction as TelegramEmoji }];
      this.bot.api.setMessageReaction(chatId, messageId, reaction).catch(() => {});
      this.pendingReactions.set(chatIdStr, messageId);

      // --- Build initial message (attachments filled async below) ---
      const msg: InboundMessage = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: chatIdStr,
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isDm,
        isGroupMention,
        messageId: String(messageId),
        threadId,
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        replyToUserId: ctx.message.reply_to_message?.from
          ? String(ctx.message.reply_to_message.from.id)
          : undefined,
        raw: ctx,
      };

      if (!hasMedia) {
        this.messageHandler(msg);
        return;
      }

      // Async media download — best-effort. If download fails, forward
      // the message without attachments so the agent still sees the caption.
      void this.downloadAndAttach(msg, media).then((enriched) => {
        if (this.messageHandler) this.messageHandler(enriched);
      });
    });

    // --- edited_message handler (3.3) ---
    this.bot.on('edited_message', (ctx) => {
      if (!this.messageHandler) return;

      const rawMsg = ctx.editedMessage as unknown as Record<string, unknown>;
      const caption = (rawMsg.text ?? rawMsg.caption ?? '') as string;
      const media = extractMedia(rawMsg);
      const hasMedia = media.length > 0;

      if (!caption && !hasMedia) return;

      const text = caption || (hasMedia ? MEDIA_PLACEHOLDER[media[0].type] : '');

      const date = typeof rawMsg.date === 'number' ? rawMsg.date : 0;
      const editDate = typeof rawMsg.edit_date === 'number' ? rawMsg.edit_date : 0;
      const ageMs = (editDate - date) * 1000;

      // Reject edits outside the configured window.
      if (ageMs > this.editWindowMs) return;

      const chatId = ctx.chat.id;
      const messageId = typeof rawMsg.message_id === 'number' ? rawMsg.message_id : 0;

      // Forum-mode thread isolation
      const rawThreadId =
        typeof rawMsg.message_thread_id === 'number' ? rawMsg.message_thread_id : undefined;
      const threadId =
        rawThreadId !== undefined && rawThreadId !== 1 ? String(rawThreadId) : undefined;

      const msg: InboundMessage = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: String(chatId),
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isEdit: true,
        isDm: ctx.chat.type === 'private',
        isGroupMention: false,
        messageId: String(messageId),
        threadId,
        replyToId: rawMsg.reply_to_message
          ? String((rawMsg.reply_to_message as Record<string, unknown>).message_id)
          : undefined,
        raw: ctx,
      };

      // Anti-thrashing: debounce rapid edits for the same messageId (200ms).
      const debounceKey = `${chatId}:${messageId}`;
      const existing = this.editDebounce.get(debounceKey);
      if (existing) clearTimeout(existing);

      this.editDebounce.set(
        debounceKey,
        setTimeout(() => {
          this.editDebounce.delete(debounceKey);
          if (!hasMedia) {
            this.messageHandler?.(msg);
            return;
          }
          void this.downloadAndAttach(msg, media).then((enriched) => {
            this.messageHandler?.(enriched);
          });
        }, 200),
      );
    });

    // Inline-keyboard taps arrive as `callback_query` updates — a separate
    // channel from `message`. Route by callback_data prefix:
    //   clr:*         → clarify surface (via callbackQueryHandler)
    //   approve:*     → approval handler
    //   deny:*        → approval handler
    //   (other)       → clarify surface (backward compat)
    this.bot.on('callback_query:data', (ctx) => {
      const cq = ctx.callbackQuery;
      const messageId = cq.message?.message_id;
      const chatId = cq.message?.chat?.id;
      if (messageId === undefined || chatId === undefined) return;

      const data = cq.data;
      const event: CallbackQueryEvent = {
        queryId: cq.id,
        data,
        chatId: String(chatId),
        messageId: String(messageId),
        userId: cq.from ? String(cq.from.id) : undefined,
        username: cq.from?.username,
        answer: async (text) => {
          await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
        },
      };

      // Route approval callbacks to the approval handler.
      if (data.startsWith('approve:') || data.startsWith('deny:')) {
        if (this.approvalDecisionHandler) {
          const isApprove = data.startsWith('approve:');
          const approvalId = data.slice(isApprove ? 8 : 5);
          if (approvalId) {
            const decision: 'allow' | 'deny' = isApprove ? 'allow' : 'deny';
            const decisionEvent: ApprovalDecisionEvent = {
              approvalId,
              decision,
              decidedBy: event.username ?? event.userId ?? 'unknown',
              channelId: event.chatId,
              messageTs: event.messageId,
            };
            void Promise.resolve()
              .then(() => this.approvalDecisionHandler?.(decisionEvent))
              .then(() => event.answer())
              .catch(() => event.answer());
          } else {
            void event.answer();
          }
        } else {
          void event.answer('No approval handler registered.');
        }
        return;
      }

      // Everything else → clarify surface.
      if (this.callbackQueryHandler) {
        this.callbackQueryHandler(event);
      }
    });

    // --- Start: webhook or long-polling (Gap 6) ---
    if (this.config.useWebhook && !this.config.webhookUrl) {
      throw new Error('TelegramAdapter: useWebhook requires webhookUrl to be set');
    }
    if (this.config.useWebhook && !this.config.webhookSecretToken) {
      throw new Error(
        'TelegramAdapter: useWebhook requires webhookSecretToken for request verification',
      );
    }
    if (this.config.useWebhook && this.config.webhookUrl) {
      await this.bot.api.setWebhook(this.config.webhookUrl, {
        secret_token: this.config.webhookSecretToken,
      });
      this.webhookCb = webhookCallback(this.bot, 'http', {
        secretToken: this.config.webhookSecretToken,
      });
    } else {
      // Non-blocking: bot.start() runs the polling loop in the background.
      // grammy's start() rejects on init failure (e.g. invalid token -> getMe 404)
      // and on terminal polling errors. Without a .catch() the rejection becomes
      // an unhandled promise rejection, which Node 24 treats as fatal — killing
      // the whole gateway and any other adapters running with it. Attach a
      // handler so a bad Telegram token degrades to a logged warning instead.
      this.bot.start({ drop_pending_updates: this.dropPendingUpdates }).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] bot polling stopped: ${detail}`);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.config.useWebhook) {
      await this.bot.api.deleteWebhook().catch(() => {});
    } else {
      await this.bot.stop();
    }
  }

  /**
   * Webhook callback for external HTTP server wiring (Gap 6).
   * Returns a plain `node:http` request handler when webhook mode is enabled,
   * `undefined` when polling. grammy's `'http'` adapter reads the raw request
   * body itself and answers the response, so the host must mount it without
   * pre-parsing the body:
   * ```ts
   * createServer((req, res) => { void adapter.webhook?.(req, res); });
   * ```
   */
  get webhook(): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined {
    return this.webhookCb;
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler for inline-keyboard taps (callback queries). Used by
   * the Telegram clarify surface to receive button clicks; not part of the
   * cross-platform `PlatformAdapter` contract.
   */
  onCallbackQuery(handler: (event: CallbackQueryEvent) => void): void {
    this.callbackQueryHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Media download helper
  // ---------------------------------------------------------------------------

  /**
   * Download media descriptors and attach them to the message. Best-effort:
   * files that exceed the size cap get a text note appended; files that fail
   * to download are silently skipped. Returns the enriched message.
   */
  private async downloadAndAttach(
    msg: InboundMessage,
    media: MediaDescriptor[],
  ): Promise<InboundMessage> {
    const attachments: Attachment[] = [];
    let textSuffix = '';
    const sessionKey = `telegram:${this.botKey}:${msg.chatId}`;

    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      // Early size check from the descriptor (before getFile round-trip)
      if (m.fileSize !== undefined && m.fileSize > MAX_FILE_SIZE) {
        textSuffix += '\n(File too large — 25 MB limit)';
        continue;
      }

      const result = await downloadTelegramFile(this.bot.api, this.bot.token, m);

      if (result === null) {
        // getFile told us it's too large, or network failure
        if (m.fileSize !== undefined && m.fileSize > MAX_FILE_SIZE) {
          textSuffix += '\n(File too large — 25 MB limit)';
        }
        continue;
      }

      const filename = m.filename ?? `att-${i}.jpg`;
      const bytes = new Uint8Array(result.data);
      const url = await this.cache.write(bytes, {
        sessionKey,
        messageId: String(msg.messageId),
        filename,
        mime: m.mimeType,
      });

      attachments.push({
        type: m.type,
        ref: `att-${i}`,
        url,
        mimeType: m.mimeType,
        filename: m.filename,
        sizeBytes: result.fileSize,
      });
    }

    const enrichedText = textSuffix ? `${msg.text}${textSuffix}` : msg.text;
    return {
      ...msg,
      text: enrichedText,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    // W3.2 — outbound media. When the gateway attaches native media
    // (OutboundMessage.attachments), deliver it as photos/documents.
    if (message.attachments && message.attachments.length > 0) {
      return this.sendWithAttachments(chatId, message);
    }
    const useHtml = this.parseMode === 'html';
    const chunks = chunkText(message.text, this.maxMessageLength);
    const totalChunks = chunks.length;
    const ids: string[] = [];
    const threadOpt = message.threadId ? { message_thread_id: Number(message.threadId) } : {};

    for (let i = 0; i < chunks.length; i++) {
      const raw = chunks[i];
      const body = useHtml ? markdownToTelegramHtml(raw) : raw;
      const parseOpt = useHtml ? ('HTML' as const) : undefined;

      const baseOpts = {
        ...(parseOpt ? { parse_mode: parseOpt } : {}),
        ...threadOpt,
      };
      const replyOpts = message.replyToId
        ? { ...baseOpts, reply_parameters: { message_id: Number(message.replyToId) } }
        : baseOpts;

      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), body, replyOpts);
        ids.push(String(sent.message_id));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // --- Gap 8: deleted reply crash fix ---
        // If the message we're replying to was deleted, retry without reply_parameters.
        if (
          message.replyToId &&
          (errMsg.includes('message to be replied not found') ||
            errMsg.includes('replied message not found'))
        ) {
          try {
            const sent = await this.bot.api.sendMessage(Number(chatId), body, baseOpts);
            ids.push(String(sent.message_id));
          } catch (retryErr) {
            return {
              ok: false,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            };
          }
        } else if (errMsg.includes('parse')) {
          // HTML/Markdown parse errors — retry as plain text (observable fallback)
          console.warn(
            `[telegram] HTML parse fallback chunk=${i + 1}/${totalChunks} hash=${chunkHash(raw)}`,
          );
          const sent = await this.bot.api
            .sendMessage(Number(chatId), raw, threadOpt)
            .catch(() => null);
          if (sent) ids.push(String(sent.message_id));
        } else {
          return { ok: false, error: errMsg };
        }
      }
    }

    // Clear receipt reaction now that the reply has landed.
    const trackedMsgId = this.pendingReactions.get(chatId);
    if (trackedMsgId !== undefined) {
      this.bot.api.setMessageReaction(Number(chatId), trackedMsgId, []).catch(() => {});
      this.pendingReactions.delete(chatId);
    }

    // --- Track thread state for thread_follow mode (Gap 4) ---
    if (message.threadId && this.threadState) {
      void this.threadState.recordPost(chatId, message.threadId);
    }

    this.rememberChunkIds(ids);
    return { ok: true, messageId: ids[0] };
  }

  /**
   * Send one or more attachments natively (W3.2). The text, when short enough
   * for a Telegram caption (≤1024 chars), rides on the first attachment;
   * otherwise it is posted as a leading message so no content is lost. Images
   * go via `sendPhoto`, everything else via `sendDocument`.
   */
  private async sendWithAttachments(
    chatId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    const atts = message.attachments ?? [];
    const threadOpt = message.threadId ? { message_thread_id: Number(message.threadId) } : {};
    const caption = message.text?.trim() ?? '';
    const captionFitsFirst = caption.length > 0 && caption.length <= 1024;
    const ids: string[] = [];

    try {
      if (caption.length > 0 && !captionFitsFirst) {
        // Too long for a caption — post the text first as its own message.
        const lead = await this.send(chatId, {
          text: caption,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        });
        if (lead.ok && lead.messageId) ids.push(lead.messageId);
      }

      for (let i = 0; i < atts.length; i++) {
        const att = atts[i];
        if (!att) continue;
        const input = toTelegramInputFile(att);
        const cap = i === 0 && captionFitsFirst ? caption : undefined;
        const opts = { ...threadOpt, ...(cap ? { caption: cap } : {}) };
        const sent =
          att.type === 'image'
            ? await this.bot.api.sendPhoto(Number(chatId), input, opts)
            : await this.bot.api.sendDocument(Number(chatId), input, opts);
        ids.push(String(sent.message_id));
      }
      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The declared voice sink. Ogg/Opus goes through `sendVoice` (voice bubble);
   * every other declared format goes through `sendAudio` (playable audio card).
   * Neither path may throw — `{ok:true}` is the delivery ledger's only proof of
   * delivery, so a platform failure must surface as `{ok:false}`.
   */
  async sendVoiceNote(
    chatId: string,
    audio: Uint8Array,
    opts: SendVoiceNoteOptions,
  ): Promise<DeliveryResult> {
    const sendOpts = {
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.threadId ? { message_thread_id: Number(opts.threadId) } : {}),
    };
    const input = new InputFile(audio, opts.filename);
    try {
      const sent =
        opts.format === 'opus' || opts.format === 'ogg'
          ? await this.bot.api.sendVoice(Number(chatId), input, sendOpts)
          : await this.bot.api.sendAudio(Number(chatId), input, sendOpts);
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** @deprecated Back-compat shim — delegates to {@link sendVoiceNote}. */
  async sendVoice(
    chatId: string,
    audio: Uint8Array,
    opts?: { threadId?: string; caption?: string },
  ): Promise<DeliveryResult> {
    return this.sendVoiceNote(chatId, audio, {
      format: 'opus',
      mimeType: 'audio/ogg; codecs=opus',
      filename: 'voice.ogg',
      ...(opts?.threadId ? { threadId: opts.threadId } : {}),
      ...(opts?.caption ? { caption: opts.caption } : {}),
    });
  }

  /**
   * Send playable audio that is NOT a voice note. This used to call
   * `sendDocument`, which is why TTS replies arrived as a downloadable file
   * instead of an audio player — that was the document-arrival bug.
   *
   * `opts.mimeType` is accepted but has no Bot API parameter to ride on:
   * `sendAudio` takes no mimetype and grammy's `InputFile` takes only bytes and
   * a filename, so Telegram infers the type from the filename extension. The
   * caller therefore supplies an extension that matches the mime type.
   */
  async sendAudio(
    chatId: string,
    audio: Uint8Array,
    filename: string,
    opts?: { threadId?: string; caption?: string; mimeType?: string },
  ): Promise<DeliveryResult> {
    try {
      const sent = await this.bot.api.sendAudio(Number(chatId), new InputFile(audio, filename), {
        ...(opts?.caption ? { caption: opts.caption } : {}),
        ...(opts?.threadId ? { message_thread_id: Number(opts.threadId) } : {}),
      });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    const useHtml = this.parseMode === 'html';
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          await this.bot.api.editMessageText(Number(chatId), Number(id), body, {
            ...(useHtml ? { parse_mode: 'HTML' as const } : {}),
          });
          return id;
        },
        append: async (chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          const sent = await this.bot.api.sendMessage(Number(chatId), body, {
            ...(useHtml ? { parse_mode: 'HTML' as const } : {}),
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

  // ---------------------------------------------------------------------------
  // Clarify interactive sends — used by the Telegram clarify surface. Not on
  // the cross-platform `PlatformAdapter` contract; the surface treats the
  // adapter structurally.
  // ---------------------------------------------------------------------------

  /**
   * Send a message with an inline keyboard. `rows` is row-major: each inner
   * array is one row of buttons. Returns the message id so the surface can
   * later edit it in place to the resolved state.
   */
  async sendInlineKeyboard(
    chatId: string,
    text: string,
    rows: InlineButton[][],
  ): Promise<DeliveryResult> {
    try {
      const kb = new InlineKeyboard();
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        for (const btn of row) kb.text(btn.label, btn.data);
        if (r < rows.length - 1) kb.row();
      }
      const sent = await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: kb,
      });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a force-reply prompt. Telegram clients auto-open the user's keyboard
   * with a "Replying to..." indicator; the inbound reply's `replyToId` is the
   * id returned here, which the surface uses to correlate.
   */
  async sendForceReply(chatId: string, text: string): Promise<DeliveryResult> {
    try {
      const sent = await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: { force_reply: true, selective: true },
      });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Edit a previously-sent prompt to a plain-text resolved state, stripping
   * any inline keyboard. Used when a clarify is answered, times out, or is
   * cancelled — the buttons go away and the message reads e.g.
   * "Which database? → postgres".
   */
  async editToPlainText(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, {
        reply_markup: { inline_keyboard: [] },
      });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool-approval cards (ApprovalCapableAdapter)
  //
  // Mirrors the Slack adapter's approval surface. The gateway's approval
  // coordinator drives these methods: post a card when a dangerous tool call
  // is gated, update it in place once the user decides. The adapter never
  // imports the gateway — the coordinator hands it a plain chatId/threadId.
  // ---------------------------------------------------------------------------

  /** Post the pending approval card with Approve/Deny inline buttons.
   *  Returns the message id (as `messageTs` for interface compat with Slack). */
  async postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }> {
    const reasonLine = input.reason ? `\nReason: ${input.reason}` : '';
    const argsLine = input.args ? `\nArgs: ${JSON.stringify(input.args)}` : '';
    const text = `Tool approval required: ${input.toolName}${reasonLine}${argsLine}`;

    const rows: InlineButton[][] = [
      [
        { label: '✅ Approve', data: `approve:${input.approvalId}` },
        { label: '❌ Deny', data: `deny:${input.approvalId}` },
      ],
    ];
    const threadOpt = input.threadId ? { message_thread_id: Number(input.threadId) } : {};

    try {
      const kb = new InlineKeyboard();
      for (const btn of rows[0]) kb.text(btn.label, btn.data);
      const sent = await this.bot.api.sendMessage(Number(input.chatId), text, {
        reply_markup: kb,
        ...threadOpt,
      });
      return { messageTs: String(sent.message_id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace a posted approval card with its resolved state — removes the
   *  buttons so the card can't be clicked twice. */
  async updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult> {
    const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
    const text = `Tool: ${input.toolName} — ${verb} by @${input.decidedBy}`;
    return this.editToPlainText(input.chatId, input.messageTs, text);
  }

  /** Register the approval-card button-click handler. The coordinator wires
   *  this to its approve() / deny() calls. */
  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void {
    this.approvalDecisionHandler = handler;
  }

  async registerCommands(cmds: { name: string; description: string }[]): Promise<void> {
    const builtins = [
      { command: 'start', description: 'Introduce the bot' },
      { command: 'new', description: 'Start a fresh session' },
      { command: 'help', description: 'Show available commands' },
      { command: 'personality', description: 'Show the bound personality' },
      { command: 'usage', description: 'Session tokens + cost' },
      { command: 'stop', description: 'Abort the current reply' },
    ];
    const pluginEntries = cmds.map((c) => ({
      command: c.name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 32),
      description: c.description.slice(0, 256),
    }));
    await this.bot.api.setMyCommands([...builtins, ...pluginEntries]).catch(() => {});
  }
}
