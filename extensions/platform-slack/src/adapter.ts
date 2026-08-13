// `SlackAdapter` — implements the `PlatformAdapter` contract by wiring
// `@slack/bolt`'s Socket Mode app to the gateway. The class is intentionally
// thin: it owns the Bolt lifecycle and the inbound→outbound plumbing.
// Triage, channel-mode, slash commands, and Block Kit rendering live in
// sibling modules.

import { join } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import type {
  AdapterCapabilities,
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  Attachment,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  Logger,
  OutboundMessage,
  PlatformAdapter,
  Storage,
} from '@ethosagent/types';
import boltPkg from '@slack/bolt';
import {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from './blocks/approval';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
} from './blocks/clarify';
import { plaintextFallback } from './blocks/shared';
import { chunkText, reflowChunks } from './chunking';
import {
  dispatch as dispatchSlash,
  type KanbanReader,
  type MemoryReader,
  type PersonalityCardReader,
  type SlashCommandPayload,
} from './commands';
import type { Binding, ChannelMode } from './config';
import { DEFAULT_CHANNEL_MODE } from './config';
import {
  type KanbanUnfurlReader,
  type PersonalityUnfurlReader,
  registerLinkEvents,
  type SessionUnfurlReader,
} from './events/links';
import { registerMemberEvents } from './events/members';
import { registerMessageEvents } from './events/messages';
import { toNativeMarkdown } from './format';
import { type ClarifyHomeReader, registerHomeEvents, type SessionReader } from './home/handlers';
import { type ApprovalActionPayload, handleApprovalAction } from './interactions/actions';
import {
  type ClarifyActionEvent,
  type ClarifyActionPayload,
  type ClarifyModalSubmissionEvent,
  type ClarifyModalSubmissionPayload,
  handleClarifyAction,
  handleClarifyModalSubmission,
} from './interactions/clarify';
import { type RawSlackFile, resolveChannelMode } from './routing/triage';
import { createUsernameResolver, type UsernameResolver } from './routing/usernames';
import { BackfillStateStore } from './store/backfill-state';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';

const { App } = boltPkg;
type App = InstanceType<typeof App>;

/**
 * Normalize a configured `webUiBaseUrl`. The value is interpolated directly
 * into Slack mrkdwn link syntax (`<url|text>`) in `blocks/session.ts`, so a
 * bad value containing `>` or `|` would break the markup. We validate it once
 * here at the boundary: accept only `http:` / `https:` URLs, and return the
 * parser-canonicalized `href` — not the raw string — so any character that
 * would otherwise breach the `<url|text>` delimiters is already percent-
 * encoded by `URL`. Trailing slashes are stripped so `${base}/sessions/<id>`
 * concatenation stays clean (path-prefixed deployments are still supported —
 * `href` preserves the path). Anything absent or invalid is treated as absent:
 * the home view already degrades gracefully to plain-text session rows when
 * there's no base URL, and a misconfigured optional cosmetic field must not
 * crash startup.
 */
function normalizeWebUiBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href.replace(/\/+$/, '');
}

/** Maximum file size in bytes that we'll download into memory. */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff']);
const SKIP_EXTS = new Set([
  'mp3',
  'mp4',
  'mov',
  'webm',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'avi',
  'mkv',
]);

export interface SlackAdapterConfig {
  /** Bot token (xoxb-...). */
  botToken: string;
  /** App-level token for socket mode (xapp-...). */
  appToken: string;
  /** Signing secret from Slack app config */
  signingSecret: string;
  /** Stable bot identity, computed once in wiring (`deriveBotKey`). Required —
   *  the adapter no longer derives its own key; routing is stamped from this. */
  botKey: string;
  /** Bot binding — used by slash commands and the member-join greeting.
   *  Optional for back-compat: callers that don't wire it get default
   *  responses. New deployments should always set this. */
  binding?: Binding;
  /** Default channel mode for unmapped channels. Defaults to `mention_only`. */
  defaultChannelMode?: ChannelMode;
  /**
   * Slack `bot_id`s whose messages reach the agent. Absent or empty drops
   * every bot/workflow message — the gate is default-closed. An allowlisted
   * bot's envelope carries `userId = <bot_id>`, so the gateway channel filter
   * must allowlist that same id for the message to be admitted.
   */
  allowedBotIds?: string[];
  /** Storage instance rooted at `~/.ethos`. When provided, the adapter
   *  persists per-channel mode overrides and thread-participation state
   *  under `~/.ethos/slack/<botKey>/`. */
  storage?: Storage;
  /** Optional override for the slack data directory. Defaults to
   *  `<storageRoot>/slack`. Tests pass an explicit dir to avoid the
   *  `~/.ethos` filesystem dance. */
  slackDir?: string;
  /** Optional memory reader for `/ethos memory show|add`. */
  memory?: MemoryReader;
  /** Optional kanban reader for `/ethos kanban list` (team bots only). */
  kanban?: KanbanReader;
  /** Optional character-sheet reader for `/ethos personality rich`. */
  personalityCard?: PersonalityCardReader;
  /** Optional session reader for the App Home "Recent sessions" section. */
  session?: SessionReader;
  /** Ethos web UI origin (no trailing slash). When set, App Home session rows
   *  deep-link to `<base>/sessions/<id>`; when absent they render as plain
   *  text. Also gates `link_shared` URL unfurling — without it the adapter
   *  can't recognize Ethos URLs and the `link_shared` handler is not
   *  registered. There is no web-UI base URL elsewhere in the adapter config
   *  today. */
  webUiBaseUrl?: string;
  /** Optional lookup-by-id reader for unfurling `<base>/sessions/<id>` URLs. */
  sessionUnfurl?: SessionUnfurlReader;
  /** Optional lookup-by-id reader for unfurling `<base>/kanban/<ticket>` URLs. */
  kanbanUnfurl?: KanbanUnfurlReader;
  /** Optional lookup-by-id reader for unfurling `<base>/personalities/<id>` URLs. */
  personalityUnfurl?: PersonalityUnfurlReader;
  /** Optional attachment cache for downloading and caching inbound file attachments. */
  cache?: AttachmentCache;
  /**
   * Character count above which one outbound reply is posted as a short lead
   * message plus the complete text uploaded as `answer.md`, instead of a
   * multi-message chunk wall. Defaults to `3 × maxMessageLength` (9000) — a
   * reply that would take four or more messages. `0` (or any non-positive
   * value) disables the fallback and restores the plain chunked send.
   */
  longReplyThresholdChars?: number;
  /**
   * Slack emoji name (no colons) set as a reaction on inbound messages to
   * acknowledge receipt, then cleared once the agent's reply has landed.
   * Default `'eyes'` (👀). Requires the `reactions:write` bot scope; missing
   * scope is swallowed silently so the bot still works without it.
   */
  receiptReaction?: string;
  /** Logger for startup diagnostics. Defaults to a silent NoopLogger. */
  logger?: Logger;
}

/**
 * Resolve an outbound `Attachment` into a `files.uploadV2` file source: a
 * decoded `Buffer` for `data:` URIs, or the raw local path string otherwise
 * (per the W3.2 outbound-media convention).
 */
function slackFileSource(att: Attachment): Buffer | string {
  const m = att.url.match(/^data:[^;,]+;base64,(.*)$/s);
  if (m?.[1] !== undefined) return Buffer.from(m[1], 'base64');
  return att.url;
}

/** Marker closing the lead message when the full answer rides as a file. */
const LONG_REPLY_SUFFIX = '\n\n*full answer attached*';
/** Filename of the uploaded complete answer. */
const LONG_REPLY_FILENAME = 'answer.md';
/** Default long-reply threshold, as a multiple of `maxMessageLength`. */
const LONG_REPLY_CHUNK_MULTIPLE = 3;

/**
 * The lead message for a long answer: the text up to the first chunk boundary
 * with the "full answer attached" marker appended. The chunk budget is reduced
 * by the marker so the composed lead still fits in one Slack message.
 */
function leadMessage(rendered: string, maxLength: number): string {
  const first = chunkText(rendered, maxLength - LONG_REPLY_SUFFIX.length)[0] ?? '';
  return `${first.trimEnd()}${LONG_REPLY_SUFFIX}`;
}

export class SlackAdapter implements PlatformAdapter, ApprovalCapableAdapter {
  readonly id: string;
  readonly displayName = 'Slack';
  get canSendTyping(): boolean {
    // Before the first probe, report true so the gateway attempts the call.
    // After probing, report the actual runtime result.
    return !this.typingProbed || this.typingAvailable;
  }
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = true;
  readonly maxMessageLength = 3000;

  get capabilities(): AdapterCapabilities {
    return {
      platform: 'slack',
      typing: this.typingAvailable,
      editDetection: true,
      replyToThreading: false,
      persistence: true,
      channelModes: true,
      homeView: true,
      joinGreeting: true,
      roleBasedApprovals: false,
      outboundFiles: true,
      webhookMode: false,
    };
  }

  readonly botKey: string;
  readonly binding: Binding | undefined;
  readonly defaultChannelMode: ChannelMode;

  private readonly allowedBotIds: string[] | undefined;
  /** `users.info` display-name resolver, cached (24 h TTL, ≤1024 entries). */
  private readonly users: UsernameResolver;
  private readonly app: App;
  private readonly client: App['client'];
  private readonly backfillState: BackfillStateStore | undefined;
  private readonly channelOverrides: ChannelOverrideStore | undefined;
  private readonly threadState: ThreadStateStore | undefined;
  private readonly memory: MemoryReader | undefined;
  private readonly kanban: KanbanReader | undefined;
  private readonly personalityCard: PersonalityCardReader | undefined;
  private readonly session: SessionReader | undefined;
  private readonly sessionUnfurl: SessionUnfurlReader | undefined;
  private readonly kanbanUnfurl: KanbanUnfurlReader | undefined;
  private readonly personalityUnfurl: PersonalityUnfurlReader | undefined;
  private readonly webUiBaseUrl: string | undefined;
  private readonly storage: Storage | undefined;
  private readonly cache: AttachmentCache | undefined;
  private readonly botToken: string;
  private messageHandler?: (message: InboundMessage) => void;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  /** Clarify-card button-click handler, wired by the Slack clarify surface. */
  private clarifyActionHandler?: (event: ClarifyActionEvent) => void;
  /** Clarify-modal submission handler, wired by the Slack clarify surface. */
  private clarifyModalSubmitHandler?: (event: ClarifyModalSubmissionEvent) => void;
  /** Source of pending clarifies for the App Home "Waiting on you" section.
   *  Wired by the Slack clarify surface after construction; read inside
   *  `start()` when the home events are registered. */
  private clarifyHomeReader?: ClarifyHomeReader;
  /** Bolt-internal inbound handle. Resolved during `start()` via auth.test. */
  private selfUserId: string | null = null;
  /** The bot's Slack display name. Resolved during `start()` via auth.test;
   *  falls back to `displayName` ('Slack') when unavailable. */
  private selfDisplayName: string | null = null;

  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  private readonly logger: Logger;

  /** Whether the Slack workspace supports the unofficial typing indicator API. */
  private typingAvailable = false;
  private typingProbed = false;

  /** Emoji name (no colons) for the inbound-receipt reaction. */
  private readonly receiptReaction: string;

  /** Long-answer snippet-fallback threshold; `<= 0` disables the fallback. */
  private readonly longReplyThresholdChars: number;
  /**
   * Pending receipt-reaction ledger. Keyed by `${chatId}:${threadTs|'top'}`
   * so concurrent in-flight replies in different threads of the same channel
   * don't clobber each other's tracked message ts. Value is the original
   * inbound message ts that carries the reaction.
   */
  private readonly pendingReactions = new Map<string, string>();
  private readonly pendingReactionsMaxEntries = 1024;

  constructor(config: SlackAdapterConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
    });
    this.client = this.app.client;
    this.users = createUsernameResolver(this.client);

    this.botKey = config.botKey;
    this.id = `slack:${this.botKey}`;
    this.binding = config.binding;
    this.defaultChannelMode = config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
    this.allowedBotIds = config.allowedBotIds;
    this.storage = config.storage;
    this.memory = config.memory;
    this.kanban = config.kanban;
    this.personalityCard = config.personalityCard;
    this.session = config.session;
    this.sessionUnfurl = config.sessionUnfurl;
    this.kanbanUnfurl = config.kanbanUnfurl;
    this.personalityUnfurl = config.personalityUnfurl;
    this.webUiBaseUrl = normalizeWebUiBaseUrl(config.webUiBaseUrl);
    this.cache = config.cache;
    this.botToken = config.botToken;
    this.receiptReaction = config.receiptReaction ?? 'eyes';
    this.longReplyThresholdChars =
      config.longReplyThresholdChars ?? LONG_REPLY_CHUNK_MULTIPLE * this.maxMessageLength;
    this.logger = (config.logger ?? noopLogger).child({ component: 'slack' });

    if (config.storage) {
      const slackDir = config.slackDir ?? join(homeEthosDir(), 'slack');
      this.backfillState = new BackfillStateStore(config.storage, slackDir, this.botKey);
      this.channelOverrides = new ChannelOverrideStore(config.storage, slackDir, this.botKey);
      this.threadState = new ThreadStateStore(config.storage, slackDir, this.botKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Hydrate persistent state before we accept events.
    await this.backfillState?.load();
    await this.channelOverrides?.load();
    await this.threadState?.load();

    // Resolve the bot's own user id so member-joined can distinguish
    // self-join from third-party joins. We tolerate failure (missing
    // scope, network blip) by leaving selfUserId null and skipping the
    // greeting — the rest of the adapter still works.
    try {
      const auth = await this.client.auth.test();
      const { user_id: userId, user: userName } = auth as { user_id?: string; user?: string };
      this.selfUserId = userId ?? null;
      this.selfDisplayName = userName ?? null;

      const botName = userName ?? userId ?? 'unknown';
      this.logger.info(`Slack bot authenticated as @${botName}`);
    } catch {
      this.selfUserId = null;
      this.selfDisplayName = null;
    }

    registerMessageEvents(
      this.app,
      {
        botKey: this.botKey,
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
        threadState: this.threadState,
        backfillState: this.backfillState,
        users: this.users,
        ...(this.allowedBotIds ? { allowedBotIds: this.allowedBotIds } : {}),
      },
      {
        onEnvelope: (msg) => {
          // Acknowledge receipt with an emoji reaction immediately, before
          // any attachment download or agent work. Matches Telegram's UX:
          // the user sees we got their message in <100 ms.
          this.addReceiptReaction(msg);

          const raw = msg.raw as Record<string, unknown> | undefined;
          const files = raw?.files as RawSlackFile[] | undefined;
          if (files && files.length > 0 && this.cache) {
            void this.extractFileAttachments(msg, files).then((enriched) => {
              this.messageHandler?.(enriched);
            });
          } else {
            this.messageHandler?.(msg);
          }
        },
      },
    );

    if (this.binding) {
      registerMemberEvents(this.app, {
        selfUserId: this.selfUserId,
        binding: this.binding,
        resolveChannelMode: (channel) =>
          resolveChannelMode(channel, {
            botKey: this.botKey,
            defaultChannelMode: this.defaultChannelMode,
            channelOverrides: this.channelOverrides,
          }),
      });
    }

    // Slash command — only register when the operator has set up `/ethos`
    // in the Slack app manifest. Bolt registers the handler regardless;
    // missing manifest entry just means Slack never delivers the event.
    this.app.command('/ethos', async ({ command, ack, respond }) => {
      await ack();
      const payload: SlashCommandPayload = {
        command: command.command,
        text: command.text ?? '',
        channel_id: command.channel_id,
        user_id: command.user_id,
        trigger_id: command.trigger_id,
      };
      const response = await dispatchSlash(payload, {
        binding: this.binding ?? { type: 'personality', name: 'unbound' },
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
        memory: this.memory,
        kanban: this.kanban,
        personalityCard: this.personalityCard,
        storage: this.storage,
        submitAgentTurn: this.makeAskSubmitter(),
      });
      try {
        await respond({
          response_type: response.responseType,
          text: response.text,
          blocks: response.blocks as never,
        });
      } catch {
        // ignore — Slack ack already sent
      }
    });

    // Approval-card button clicks. Bolt delivers `block_actions` events here;
    // we parse the raw payload down to the fields `handleApprovalAction`
    // needs and let it route to the coordinator's decision handler. Registered
    // unconditionally — a click with no handler wired is a harmless no-op.
    //
    // Slack is the one thing we don't control: a malformed payload or Bolt
    // API drift must not throw inside the event loop. We defensively probe
    // the shape before dereferencing, ack when we can, and bail otherwise.
    const onApprovalButton = async (raw: unknown): Promise<void> => {
      const evt = (raw ?? {}) as {
        ack?: unknown;
        body?: { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string } };
        action?: { action_id?: string; value?: string };
      };
      if (typeof evt.ack === 'function') {
        // `ack()` is the one call we can't reason about — a Bolt/Slack API
        // change could make it throw synchronously, not just reject. Wrap the
        // invocation itself, not only the returned promise, so a bad ack can
        // never escape this handler and poison Bolt's event loop.
        try {
          await (evt.ack as () => Promise<void>)();
        } catch {
          // best-effort ack — proceed with the decision regardless
        }
      }
      const handler = this.approvalDecisionHandler;
      if (!handler) return;
      const body = evt.body;
      const action = evt.action;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof action !== 'object' ||
        action === null
      )
        return;
      const payload: ApprovalActionPayload = {
        actionId: action.action_id ?? '',
        approvalId: action.value ?? '',
        userId: body.user?.id ?? '',
        channelId: body.channel?.id ?? '',
        messageTs: body.message?.ts ?? '',
      };
      await handleApprovalAction(payload, { onDecision: async (event) => handler(event) });
    };
    this.app.action(APPROVE_ACTION_ID, onApprovalButton);
    this.app.action(DENY_ACTION_ID, onApprovalButton);

    // Clarify-card button clicks. Bolt delivers `block_actions` events here
    // for the choice/cancel/answer buttons; we narrow the raw payload to
    // `ClarifyActionPayload` and let the pure handler route it. Same shape as
    // the approval handler — defensively probe the payload before dereferencing
    // and ack as the very first thing.
    const onClarifyButton = async (raw: unknown): Promise<void> => {
      const evt = (raw ?? {}) as {
        ack?: unknown;
        body?: {
          user?: { id?: string };
          channel?: { id?: string };
          message?: { ts?: string };
          trigger_id?: string;
          /** Present for App Home / modal-triggered block_actions; absent for
           *  channel-message clicks. We use it to detect the Home tab path. */
          view?: { type?: string };
        };
        action?: { action_id?: string; value?: string };
      };
      if (typeof evt.ack === 'function') {
        try {
          await (evt.ack as () => Promise<void>)();
        } catch {
          // best-effort ack — proceed regardless
        }
      }
      const handler = this.clarifyActionHandler;
      if (!handler) return;
      const body = evt.body;
      const action = evt.action;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof action !== 'object' ||
        action === null
      )
        return;
      // App Home payloads omit `body.channel` and `body.message` entirely
      // (the click happened on a view, not a channel message). Detect this
      // so the surface can relax its channel/messageTs cross-tenant gate
      // for Home — a Home view is per-user, so cross-message replay isn't
      // a risk; the gate's purpose doesn't apply.
      const fromHome = body.view?.type === 'home' || !body.channel;
      const payload: ClarifyActionPayload = {
        actionId: action.action_id ?? '',
        value: action.value ?? '',
        userId: body.user?.id ?? '',
        channelId: body.channel?.id ?? '',
        messageTs: body.message?.ts ?? '',
        triggerId: body.trigger_id ?? '',
        fromHome,
      };
      await handleClarifyAction(payload, { onAction: async (e) => handler(e) });
    };
    this.app.action(CLARIFY_CHOICE_ACTION_ID, onClarifyButton);
    this.app.action(CLARIFY_CANCEL_ACTION_ID, onClarifyButton);
    this.app.action(CLARIFY_ANSWER_ACTION_ID, onClarifyButton);

    // Free-form modal submission. Bolt delivers `view_submission` events
    // when the user clicks Submit on the clarify modal. Same defensive shape.
    this.app.view(CLARIFY_MODAL_CALLBACK_ID, async (raw) => {
      const evt = raw as {
        ack?: unknown;
        body?: {
          user?: { id?: string };
          view?: {
            callback_id?: string;
            private_metadata?: string;
            state?: { values?: Record<string, Record<string, { value?: string }>> };
          };
        };
      };
      if (typeof evt.ack === 'function') {
        try {
          await (evt.ack as () => Promise<void>)();
        } catch {
          // best-effort ack
        }
      }
      const handler = this.clarifyModalSubmitHandler;
      if (!handler) return;
      const view = evt.body?.view;
      if (!view) return;
      const payload: ClarifyModalSubmissionPayload = {
        callbackId: view.callback_id ?? '',
        privateMetadata: view.private_metadata ?? '',
        userId: evt.body?.user?.id ?? '',
        values: view.state?.values ?? {},
      };
      await handleClarifyModalSubmission(payload, { onSubmit: async (e) => handler(e) });
    });

    // App Home tab. `registerHomeEvents` wires `app_home_opened` (publish the
    // view) and the `home:refresh` button (re-publish). It gathers data from
    // the injected readers; sections backed by an unwired reader degrade to a
    // tasteful empty state. Registered unconditionally — when `binding` is
    // unset the header still renders with the default identity.
    registerHomeEvents(this.app, {
      binding: this.binding ?? { type: 'personality', name: 'unbound' },
      displayName: this.selfDisplayName ?? this.displayName,
      channelOverrides: this.channelOverrides,
      session: this.session,
      memory: this.memory,
      kanban: this.kanban,
      clarify: this.clarifyHomeReader,
      webUiBaseUrl: this.webUiBaseUrl,
    });

    // `link_shared` URL unfurling. `registerLinkEvents` is a no-op when
    // `webUiBaseUrl` is unset (it can't recognize an Ethos URL without a base
    // to match against); the lookup readers are optional and each URL type
    // degrades to a skipped unfurl when its reader is absent.
    registerLinkEvents(this.app, {
      webUiBaseUrl: this.webUiBaseUrl,
      session: this.sessionUnfurl,
      kanban: this.kanbanUnfurl,
      personality: this.personalityUnfurl,
    });

    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.canSendTyping) return;
    try {
      await (
        this.app.client as unknown as {
          apiCall: (method: string, opts: Record<string, unknown>) => Promise<unknown>;
        }
      ).apiCall('conversations.setTypingIndicator', {
        channel: chatId,
        typing: true,
      });
      if (!this.typingProbed) {
        this.typingProbed = true;
        this.typingAvailable = true;
      }
    } catch {
      this.typingProbed = true;
      this.typingAvailable = false;
    }
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    // W3.2 — outbound media. Native file upload via files.uploadV2.
    if (message.attachments && message.attachments.length > 0) {
      return this.sendWithAttachments(chatId, message);
    }
    try {
      // `threadId` is the canonical thread routing field. We deliberately
      // do NOT fall back to `replyToId` — that field has Discord/Telegram
      // "this is a reply to message X" semantics and would over-thread
      // every Slack reply if accidentally set by a generic caller. The
      // Gateway sets `threadId` from the originating inbound; nothing
      // sets `replyToId` for outbound today.
      const threadTs = message.threadId;

      const rendered = toNativeMarkdown(message.text);
      const chunks = chunkText(rendered, this.maxMessageLength);

      // A reply long enough to become a message wall goes out as a lead
      // message plus the whole answer as `answer.md`. `undefined` means the
      // fallback declined to take the reply — fall through to the wall.
      let ids = this.isLongReply(rendered)
        ? await this.sendLongAnswer(chatId, rendered, chunks, threadTs)
        : undefined;

      if (!ids) {
        ids = [];
        for (const chunk of chunks) {
          const result = await this.client.chat.postMessage({
            channel: chatId,
            text: chunk,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            mrkdwn: true,
          });
          const ts = result.ts as string | undefined;
          if (ts) ids.push(ts);
        }
      }

      this.rememberChunkIds(ids);
      // `thread_follow` mode needs to know we've posted in this thread.
      if (threadTs) {
        await this.threadState?.recordPost(chatId, threadTs);
      }
      // Clear the receipt reaction now that the reply has landed.
      this.clearReceiptReaction(chatId, threadTs);
      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Upload one or more attachments natively (W3.2) via `files.uploadV2`. The
   * text rides along as `initial_comment` on the first file; subsequent files
   * upload without a comment. `Attachment.url` is either a
   * `data:<mime>;base64,<...>` URI (inline bytes → Buffer) or a local path.
   */
  private async sendWithAttachments(
    chatId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    const atts = message.attachments ?? [];
    const threadTs = message.threadId;
    const comment = message.text?.trim() ?? '';
    try {
      let firstTs: string | undefined;
      for (let i = 0; i < atts.length; i++) {
        const att = atts[i];
        if (!att) continue;
        const file = slackFileSource(att);
        const res = (await this.client.files.uploadV2({
          channel_id: chatId,
          file,
          filename: att.filename ?? att.ref,
          ...(i === 0 && comment ? { initial_comment: comment } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })) as { files?: Array<{ ts?: string }> };
        if (firstTs === undefined) firstTs = res.files?.[0]?.ts;
      }
      if (threadTs) await this.threadState?.recordPost(chatId, threadTs);
      this.clearReceiptReaction(chatId, threadTs);
      return { ok: true, ...(firstTs ? { messageId: firstTs } : {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Long-answer snippet fallback (SP-B3)
  //
  // Four-plus messages of prose is a wall nobody reads. Past
  // `longReplyThresholdChars` the reply becomes a lead message ending in
  // "*full answer attached*" plus the complete text uploaded as `answer.md`,
  // threaded under the lead. The upload is an attachment, not a `send()`, so
  // the gateway's `MessageDedupCache` — which gates `adapter.send()` on the
  // reply text — is untouched by it.
  // ---------------------------------------------------------------------------

  /** Whether a rendered reply crosses the long-answer threshold. */
  private isLongReply(rendered: string): boolean {
    return this.longReplyThresholdChars > 0 && rendered.length > this.longReplyThresholdChars;
  }

  /**
   * Upload the complete answer as `answer.md` under `threadTs`.
   * `initial_comment` is deliberately unset: the lead message already carries
   * the opening text and a comment would repeat it.
   *
   * Returns `false` instead of throwing when the upload fails — including the
   * `missing_scope` case for a workspace that never granted `files:write`.
   * Silent degradation is the same policy the receipt reaction and the
   * username resolver follow; the caller falls back to the chunk wall.
   */
  private async uploadAnswerFile(chatId: string, text: string, threadTs: string): Promise<boolean> {
    try {
      await this.client.files.uploadV2({
        channel_id: chatId,
        file: Buffer.from(text, 'utf8'),
        filename: LONG_REPLY_FILENAME,
        thread_ts: threadTs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Post the lead message and attach the full answer. Returns the posted
   * message ids, or `undefined` when Slack accepted the lead but returned no
   * `ts` — without it the upload can't be threaded under the lead, so the
   * caller posts the ordinary wall instead.
   */
  private async sendLongAnswer(
    chatId: string,
    rendered: string,
    chunks: string[],
    threadTs: string | undefined,
  ): Promise<string[] | undefined> {
    const lead = await this.client.chat.postMessage({
      channel: chatId,
      text: leadMessage(rendered, this.maxMessageLength),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      mrkdwn: true,
    });
    const leadTs = lead.ts as string | undefined;
    if (!leadTs) return undefined;

    if (await this.uploadAnswerFile(chatId, rendered, threadTs ?? leadTs)) return [leadTs];

    // The lead promised an attachment that will never arrive. Expand it back
    // into today's chunk wall in place — a message wall beats a broken promise.
    return reflowChunks(chunks, [leadTs], this.reflowOps(chatId, threadTs));
  }

  /** `reflowChunks` operations bound to one channel. `threadTs` keeps appended
   *  chunks in the thread the reply belongs to; `editMessage` has no thread
   *  context and passes none, exactly as before. */
  private reflowOps(
    chatId: string,
    threadTs?: string,
  ): {
    edit: (id: string, text: string) => Promise<string>;
    append: (text: string) => Promise<string>;
    deleteId: (id: string) => Promise<void>;
  } {
    return {
      edit: async (ts, chunk) => {
        await this.client.chat.update({ channel: chatId, ts, text: chunk });
        return ts;
      },
      append: async (chunk) => {
        const result = await this.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          mrkdwn: true,
        });
        return (result.ts as string | undefined) ?? '';
      },
      deleteId: async (ts) => {
        await this.client.chat.delete({ channel: chatId, ts });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Receipt reactions — best-effort acknowledgement of inbound messages.
  //
  // Telegram has the same behaviour: set 👀 on inbound, clear when the reply
  // lands. Slack's analogue uses `reactions.add`/`reactions.remove`, which
  // require the `reactions:write` bot scope. Both calls are fire-and-forget;
  // missing scope, transient network failures, and "already_reacted" are all
  // swallowed silently so the agent still works without the scope.
  // ---------------------------------------------------------------------------

  /** Compose the pending-reactions ledger key for a (channel, thread) pair.
   *  Top-level posts have no threadTs and bucket under the `'top'` suffix. */
  private reactionLaneKey(chatId: string, threadTs: string | undefined): string {
    return `${chatId}:${threadTs ?? 'top'}`;
  }

  private addReceiptReaction(msg: InboundMessage): void {
    const ts = msg.messageId;
    if (!ts) return;
    const lane = this.reactionLaneKey(msg.chatId, msg.threadId);

    // Bound the ledger so a long-running adapter never grows unboundedly when
    // sends fail repeatedly and never clear their entries.
    while (
      this.pendingReactions.size >= this.pendingReactionsMaxEntries &&
      !this.pendingReactions.has(lane)
    ) {
      const oldestKey = this.pendingReactions.keys().next().value;
      if (oldestKey === undefined) break;
      this.pendingReactions.delete(oldestKey);
    }

    this.pendingReactions.set(lane, ts);
    this.client.reactions
      .add({ channel: msg.chatId, timestamp: ts, name: this.receiptReaction })
      .catch(() => {});
  }

  private clearReceiptReaction(chatId: string, threadTs: string | undefined): void {
    const lane = this.reactionLaneKey(chatId, threadTs);
    const ts = this.pendingReactions.get(lane);
    if (!ts) return;
    this.pendingReactions.delete(lane);
    this.client.reactions
      .remove({ channel: chatId, timestamp: ts, name: this.receiptReaction })
      .catch(() => {});
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    opts?: { final?: boolean },
  ): Promise<DeliveryResult> {
    try {
      const rendered = toNativeMarkdown(text);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];
      let newChunks = chunkText(rendered, this.maxMessageLength);

      // Long-answer fallback on the TERMINAL edit only. An intermediate draft
      // flush can't know how much more text is coming, and collapsing on every
      // flush would upload one `answer.md` per flush. The upload runs BEFORE
      // the collapse: if the file never lands, the chunk wall stays exactly as
      // it is rather than being deleted with nothing to replace it.
      // `editMessage` carries no thread context, so the lead's own ts is the
      // thread parent for the upload. When the draft already lives in a
      // thread, Slack files that under the same parent thread.
      if (opts?.final && this.isLongReply(rendered)) {
        const leadTs = existingIds[0] ?? messageId;
        if (await this.uploadAnswerFile(chatId, rendered, leadTs)) {
          newChunks = [leadMessage(rendered, this.maxMessageLength)];
        }
      }

      const updatedIds = await reflowChunks(newChunks, existingIds, this.reflowOps(chatId));

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

  // ---------------------------------------------------------------------------
  // Tool-approval cards
  //
  // The Slack adapter is the only platform with an interactive approval
  // affordance, so these methods live here rather than on `PlatformAdapter`.
  // The approval coordinator (apps layer) drives them: post a card when a
  // dangerous tool call is gated, update it in place once resolved. The
  // adapter never imports `@ethosagent/gateway` — the coordinator hands it a
  // plain `chatId` / `threadId`, so layering stays one-directional.
  // ---------------------------------------------------------------------------

  /** Post the pending approval card. Returns the message `ts` so the
   *  coordinator can `chat.update` it in place once the user decides. */
  async postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }> {
    const blocks = approvalPendingBlocks({
      approvalId: input.approvalId,
      toolName: input.toolName,
      reason: input.reason,
      args: input.args,
    });
    try {
      const result = await this.client.chat.postMessage({
        channel: input.chatId,
        text: plaintextFallback(blocks),
        blocks: blocks as never,
        ...(input.threadId ? { thread_ts: input.threadId } : {}),
      });
      const ts = result.ts as string | undefined;
      if (!ts) return { error: 'Slack accepted the approval card but returned no message ts' };
      return { messageTs: ts };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace a posted approval card with its resolved (decision) state —
   *  removes the buttons so the card can't be clicked twice. */
  async updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult> {
    const blocks = approvalResolvedBlocks({
      toolName: input.toolName,
      decision: input.decision,
      decidedBy: input.decidedBy,
    });
    try {
      await this.client.chat.update({
        channel: input.chatId,
        ts: input.messageTs,
        text: plaintextFallback(blocks),
        blocks: blocks as never,
      });
      return { ok: true };
    } catch (err) {
      // A stale card left showing live buttons is misleading on a privileged
      // surface — report the failure rather than swallowing it. The caller
      // (gateway) decides how loud to be; the decision itself is already
      // final regardless.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Register the approval-card button-click handler. The coordinator wires
   *  this to its `approve()` / `deny()` calls. */
  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void {
    this.approvalDecisionHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Clarify cards (interactive question/answer)
  //
  // Mirrors the approval-card lifecycle. The Slack clarify surface drives
  // them: post a card when the agent calls `clarify`, update it in place
  // once resolved (answered, timed out, or cancelled). The adapter takes
  // the rendered Block Kit blocks from the surface — block builders live in
  // `blocks/clarify.ts` and stay pure.
  // ---------------------------------------------------------------------------

  /** Post the pending clarify card. Returns the message `ts` so the surface
   *  can `chat.update` it in place once the row resolves. */
  async postClarifyCard(input: {
    chatId: string;
    threadId?: string;
    blocks: unknown[];
  }): Promise<{ messageTs: string } | { error: string }> {
    try {
      const result = await this.client.chat.postMessage({
        channel: input.chatId,
        text: plaintextFallback(input.blocks as never),
        blocks: input.blocks as never,
        ...(input.threadId ? { thread_ts: input.threadId } : {}),
      });
      const ts = result.ts as string | undefined;
      if (!ts) return { error: 'Slack accepted the clarify card but returned no message ts' };
      return { messageTs: ts };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace a posted clarify card with its resolved state — removes the
   *  buttons so the card can't be clicked twice. */
  async updateClarifyCard(input: {
    chatId: string;
    messageTs: string;
    blocks: unknown[];
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.client.chat.update({
        channel: input.chatId,
        ts: input.messageTs,
        text: plaintextFallback(input.blocks as never),
        blocks: input.blocks as never,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Open a Block Kit modal — used for free-form clarify answers. */
  async openClarifyModal(input: {
    triggerId: string;
    view: Record<string, unknown>;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.client.views.open({
        trigger_id: input.triggerId,
        view: input.view as never,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Register the clarify-card button-click handler. The Slack clarify
   *  surface wires this to its `bridge.respond()` calls. */
  onClarifyAction(handler: (event: ClarifyActionEvent) => void): void {
    this.clarifyActionHandler = handler;
  }

  /** Register the clarify-modal submission handler. */
  onClarifyModalSubmit(handler: (event: ClarifyModalSubmissionEvent) => void): void {
    this.clarifyModalSubmitHandler = handler;
  }

  /** Register the App Home "Waiting on you" data source. Set by the clarify
   *  surface after construction; consumed inside `start()`. Idempotent —
   *  the most recent set wins, but only the value present at `start()` time
   *  is registered with Bolt. */
  setClarifyHomeReader(reader: ClarifyHomeReader): void {
    this.clarifyHomeReader = reader;
  }

  // ---------------------------------------------------------------------------
  // File attachment extraction
  // ---------------------------------------------------------------------------

  /**
   * Enrich an inbound envelope with file attachments downloaded from Slack.
   * Best-effort: files that fail to download or exceed the size cap are
   * silently skipped. Audio/video files are skipped in v1.
   */
  private async extractFileAttachments(
    envelope: InboundMessage,
    files: RawSlackFile[],
  ): Promise<InboundMessage> {
    if (!this.cache || files.length === 0) return envelope;

    const attachments: Attachment[] = [];
    const sessionKey = `slack:${this.botKey}:${envelope.chatId}`;
    const messageId = envelope.messageId ?? String(Date.now());

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.filetype ?? '').toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if ((file.size ?? 0) > MAX_FILE_SIZE) continue;
      if (!file.url_private_download) continue;

      const type = IMAGE_EXTS.has(ext) ? ('image' as const) : ('file' as const);

      try {
        const res = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!res.ok) continue;
        const contentLength = Number(res.headers.get('content-length') ?? 0);
        if (contentLength > MAX_FILE_SIZE) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_FILE_SIZE) continue;
        const filename = file.name ?? `att-${i}`;
        const mime = file.mimetype ?? 'application/octet-stream';
        const url = await this.cache.write(bytes, {
          sessionKey,
          messageId,
          filename,
          mime,
        });
        attachments.push({
          type,
          ref: `att-${i}`,
          url,
          mimeType: mime,
          filename: file.name,
          sizeBytes: file.size,
        });
      } catch {
        // Download failed — skip this file silently
      }
    }

    if (attachments.length === 0) return envelope;

    return {
      ...envelope,
      attachments,
    };
  }

  async health(): Promise<{
    ok: boolean;
    latencyMs?: number;
  }> {
    try {
      const start = Date.now();
      await this.client.auth.test();
      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch {
      return { ok: false };
    }
  }

  /** Builds the `/ethos ask` callback that injects a synthetic inbound
   *  message into the gateway. Returns undefined when no `messageHandler`
   *  is registered (i.e. the gateway hasn't wired up yet). */
  private makeAskSubmitter():
    | ((input: { channel: string; user: string; text: string }) => Promise<void>)
    | undefined {
    const handler = this.messageHandler;
    if (!handler) return undefined;
    return async (input) => {
      const envelope: InboundMessage = {
        platform: 'slack',
        botKey: this.botKey,
        chatId: input.channel,
        userId: input.user,
        text: input.text,
        isDm: false,
        // Slash invocations are always treated as a direct address — the
        // user explicitly invoked the bot, so channel-mode is bypassed.
        // No `threadId`: slash commands fire from the channel root.
        isGroupMention: true,
        raw: { source: 'slash:/ethos ask' },
      };
      handler(envelope);
    };
  }

  async registerCommands(_cmds: { name: string; description: string }[]): Promise<void> {
    // Slack requires manual slash command registration in the app dashboard.
    // Plugin slash commands are dispatched by the gateway as normal text.
  }
}

function homeEthosDir(): string {
  // Late import keeps node:os out of the test surface that doesn't need it.
  // Same convention the rest of the repo uses (apps/ethos/src/config.ts).
  // We reach for HOME directly so the adapter doesn't pull in
  // `apps/ethos/src/config.ts` (an apps→extension dependency would
  // invert the layering).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.ethos');
}
