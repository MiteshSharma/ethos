import { join } from 'node:path';
import { ChannelOverrideStore, evaluateChannelMode } from '@ethosagent/core';
import type {
  AdapterCapabilities,
  AdapterVoiceCaps,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SendVoiceNoteOptions,
  Storage,
  VoiceOutboundAdapter,
} from '@ethosagent/types';
import { type ChannelMode, ChannelModeSchema, DEFAULT_CHANNEL_MODE } from './config';
import { downloadMedia } from './media';
import {
  hasMedia,
  isBotMentioned,
  parseInboundMessage,
  type RawWhatsAppMessage,
} from './message-parser';
import { resolveSessionDir } from './session-store';

export interface WhatsAppAdapterConfig {
  id?: string;
  /** Explicit botKey supplied by the gateway so the adapter's stamped key
   *  matches the `GatewayBotConfig` it routes to. Wins over `id` when set. */
  botKey?: string;
  sessionDir: string;
  /** Mode for every group chat without a stored override. Absent = `all`
   *  (`DEFAULT_CHANNEL_MODE`), which is what absence has always meant here. */
  defaultMode?: ChannelMode;
  /** Where per-chat mode overrides live. Absent = no override store, and every
   *  chat uses `defaultMode` — which is why the adapter's advertised
   *  `channelModes: true` needs this wired to be true. */
  storage?: Storage;
  /** Base directory for adapter state. Default `'whatsapp'`; the override file
   *  is `<whatsappDir>/<botKey>/channel-overrides.jsonl`. */
  whatsappDir?: string;
  allowedJids?: string[];
  /** Reject messages from JIDs not in allowedJids. Default true.
   *  Set to false to allow all senders (open mode — not recommended for production). */
  denyUnknown?: boolean;
  /** Message sent to rejected senders. Omit for silent reject (default). */
  denyMessage?: string;
  cache?: AttachmentCache;
  onQr?: (qr: string | null) => void;
  /** When set, link via phone-number pairing code instead of QR. The adapter
   *  calls Baileys `requestPairingCode` with the digits-only number and emits
   *  the resulting ~8-char code through `onPairingCode`. */
  phoneNumber?: string;
  onPairingCode?: (code: string | null) => void;
  /**
   * Override for the largest inbound media message this adapter will download
   * (bytes). Absent = the 25 MB default in `downloadMedia`. Set from
   * `gateway.maxInboundMediaBytes`.
   */
  maxInboundMediaBytes?: number;
}

export class WhatsAppAdapter implements PlatformAdapter, VoiceOutboundAdapter {
  readonly id: string;
  readonly displayName = 'WhatsApp';
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 65536;
  readonly capabilities: AdapterCapabilities = {
    platform: 'whatsapp',
    channelModes: true,
  };

  /**
   * Declared voice capabilities. `ptt: true` is the flag that turns an audio
   * message into a push-to-talk voice bubble rather than an audio file
   * attachment — WhatsApp has no other way to express the difference.
   */
  readonly voiceCaps: AdapterVoiceCaps = {
    inbound: ['ogg', 'opus', 'm4a', 'amr'],
    outbound: {
      formats: ['opus', 'ogg'],
      kind: 'voice_note',
      flags: { ptt: true },
      maxBytes: 16 * 1024 * 1024,
    },
  };

  readonly botKey: string;
  private sock: unknown = null;
  private reconnecting = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private pairingCodeRequested = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandler?: (message: InboundMessage) => void;
  private botJid = '';
  private readonly config: WhatsAppAdapterConfig;
  private readonly pendingReactions = new Map<string, string>();
  private readonly defaultChannelMode: ChannelMode;
  private readonly channelOverrides?: ChannelOverrideStore<ChannelMode>;

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
    this.botKey =
      config.botKey ??
      config.id ??
      `wa-${config.sessionDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
    this.id = `whatsapp:${this.botKey}`;
    this.defaultChannelMode = config.defaultMode ?? DEFAULT_CHANNEL_MODE;

    // Same shape as Discord's: the shared store takes the PER-BOT directory
    // and the adapter's own mode enum, so callers join.
    if (config.storage) {
      this.channelOverrides = new ChannelOverrideStore(
        config.storage,
        join(config.whatsappDir ?? 'whatsapp', this.botKey),
        ChannelModeSchema,
      );
    }

    const denyUnknown = config.denyUnknown ?? true;
    if (denyUnknown && (!config.allowedJids || config.allowedJids.length === 0)) {
      throw new Error(
        'platform-whatsapp: denyUnknown is true (default) but allowedJids is empty — ' +
          'all inbound messages would be dropped. Set allowedJids to a non-empty list, ' +
          'or set denyUnknown: false to allow all senders.',
      );
    }
  }

  async start(): Promise<void> {
    if (this.reconnecting) return;
    this.stopped = false;

    await this.channelOverrides?.load();

    const sessionDir = resolveSessionDir({
      sessionDir: this.config.sessionDir,
      botKey: this.botKey,
    });

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.makeWASocket ?? baileys.default;
    const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    // Phone-number pairing: when a number is configured and the device is not
    // yet linked, request an ~8-char pairing code instead of rendering a QR.
    // Baileys requires this be called before the device registers.
    if (this.config.phoneNumber && !sock.authState.creds.registered && !this.pairingCodeRequested) {
      // Request the code only once per process. A reconnect must never request a
      // new one — it would invalidate the code the user is currently typing.
      this.pairingCodeRequested = true;
      const digits = this.config.phoneNumber.replace(/[^0-9]/g, '');
      // Brief delay so the socket finishes opening its WS before the request.
      setTimeout(() => {
        sock
          .requestPairingCode(digits)
          .then((code) => {
            this.config.onPairingCode?.(code);
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[whatsapp] requestPairingCode failed: ${detail}`);
          });
      }, 3000);
    }

    // biome-ignore lint/suspicious/noExplicitAny: Baileys ConnectionState type varies across versions
    sock.ev.on('connection.update', (update: any) => {
      if (update.qr && !this.config.phoneNumber) {
        import('qrcode-terminal')
          .then((qrterm) => {
            qrterm.generate(update.qr, { small: true });
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[whatsapp] QR render failed: ${detail}`);
          });
        if (this.config.onQr) this.config.onQr(update.qr);
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        const registered = sock.authState.creds.registered;
        if (code !== DisconnectReason.loggedOut && !this.stopped) {
          this.reconnectAttempts += 1;
          if (!registered && this.reconnectAttempts > 4) {
            // Pairing keeps failing across retries — almost certainly rate-limited.
            // Stop the spiral instead of requesting yet another code.
            console.error(
              '[whatsapp] pairing failed repeatedly — WhatsApp is likely rate-limiting this number from too many attempts. Stop the gateway, wait several minutes, then restart to try once more.',
            );
            this.config.onPairingCode?.(null);
            this.stopped = true;
            return;
          }
          const delay = Math.min(3000 * 2 ** (this.reconnectAttempts - 1), 60000);
          this.reconnecting = true;
          this.sock = null;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnecting = false;
            this.start();
          }, delay);
        }
      }

      if (update.connection === 'open') {
        this.reconnectAttempts = 0;
        this.botJid = sock.user?.id ?? '';
        if (this.config.onQr) this.config.onQr(null);
        this.config.onPairingCode?.(null);
      }
    });

    // biome-ignore lint/suspicious/noExplicitAny: Baileys WAMessage type varies across versions
    sock.ev.on('messages.upsert', async (upsert: any) => {
      if (upsert.type !== 'notify') return;
      const messages = upsert.messages as RawWhatsAppMessage[];

      for (const msg of messages) {
        if (!this.messageHandler) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid ?? '';
        const isDm = !jid.endsWith('@g.us');

        const denyUnknown = this.config.denyUnknown ?? true;
        if (denyUnknown && this.config.allowedJids) {
          const checkJid = isDm ? jid : (msg.key.participant ?? '');
          const number = checkJid.split('@')[0].replace(/[^0-9]/g, '');
          const matched = this.config.allowedJids.some((allowed) => {
            const normalizedAllowed = allowed.replace(/[^0-9]/g, '');
            return number === normalizedAllowed;
          });
          if (!matched) {
            if (this.config.denyMessage && this.sock) {
              const s = this.sock as {
                sendMessage: (jid: string, content: unknown) => Promise<unknown>;
              };
              await s.sendMessage(jid, { text: this.config.denyMessage }).catch(() => {});
            }
            continue;
          }
        }

        // The channel-mode decision comes BEFORE the media block on purpose: a
        // message this mode drops must not cost a download. `isBotMentioned` is
        // the parser's own test, so the gate and the envelope can no longer
        // disagree about what counts as a mention.
        const decision = evaluateChannelMode({
          isDm,
          isGroupMention: !isDm && isBotMentioned(msg, this.botJid),
          channelMode: this.channelOverrides?.get(jid)?.mode ?? this.defaultChannelMode,
        });
        if (!decision.shouldRecord) continue;
        const recordOnly = !decision.shouldReply;

        // Recorded, not answered — and the gateway's transcript row is TEXT.
        // Downloading here would spend the bandwidth to throw the bytes away,
        // and leave a third party's media in the attachment cache under a
        // lifetime the transcript's retention never touches. A caption is not
        // lost by skipping: `extractText` reads it off the media node itself.
        let attachments: import('@ethosagent/types').Attachment[] | undefined;
        if (hasMedia(msg) && this.config.cache && !recordOnly) {
          const sessionKey = `whatsapp:${this.botKey}:${jid}`;
          try {
            const att = await downloadMedia(
              msg,
              async (m) => {
                // biome-ignore lint/suspicious/noExplicitAny: Baileys downloadMediaMessage signature varies across versions
                const buffer = await (downloadMediaMessage as any)(m, 'buffer', {});
                return Buffer.from(buffer);
              },
              this.config.cache,
              sessionKey,
              this.config.maxInboundMediaBytes,
            );
            if (att) attachments = [att];
          } catch {
            // best-effort media download
          }
        }

        const parsed = parseInboundMessage(msg, this.botJid, this.botKey, attachments);
        if (!parsed) continue;
        // Recorded, not answered: the gateway writes the transcript row and
        // returns before the channel filter runs.
        parsed.recordOnly = recordOnly;

        // Receipt reaction — skipped when the message is only being recorded.
        // A reaction is a visible reply, and an observed room is a room the
        // operator told the agent to be silent in.
        if (decision.shouldReply) {
          try {
            await (
              sock as {
                sendMessage: (jid: string, content: unknown) => Promise<unknown>;
              }
            ).sendMessage(jid, {
              react: { text: '\u{1F440}', key: msg.key },
            });
            this.pendingReactions.set(jid, msg.key.id ?? '');
          } catch {
            // best-effort reaction
          }
        }

        this.messageHandler(parsed);
      }
    });

    this.sock = sock;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    if (this.sock) {
      const sock = this.sock as {
        end: (reason?: unknown) => void;
      };
      sock.end(undefined);
      this.sock = null;
    }
  }

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    if (!this.sock) return { ok: false, error: 'Not connected' };

    const sock = this.sock as {
      sendMessage: (
        jid: string,
        content: unknown,
        opts?: unknown,
      ) => Promise<{ key: { id?: string } }>;
    };

    const text = message.text;
    const chunks = chunkText(text, this.maxMessageLength);

    let firstId: string | undefined;
    for (const chunk of chunks) {
      try {
        const opts = message.replyToId
          ? {
              quoted: {
                key: { remoteJid: chatId, id: message.replyToId },
              },
            }
          : undefined;

        const sent = await sock.sendMessage(chatId, { text: chunk }, opts);
        if (!firstId) firstId = sent.key.id;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Clear receipt reaction
    const pendingId = this.pendingReactions.get(chatId);
    if (pendingId) {
      try {
        await sock.sendMessage(chatId, {
          react: {
            text: '',
            key: { remoteJid: chatId, id: pendingId },
          },
        });
      } catch {
        // best-effort
      }
      this.pendingReactions.delete(chatId);
    }

    return { ok: true, messageId: firstId };
  }

  /**
   * The declared voice sink. `ptt: true` is what makes WhatsApp render a
   * push-to-talk voice bubble instead of an audio-file attachment — it mirrors
   * `voiceCaps.outbound.flags`. Never throws: `{ok:true}` is the delivery
   * ledger's only proof of delivery.
   *
   * `opts.threadId` is ignored — WhatsApp has no thread concept, which is why
   * `send()` uses `replyToId` as a quote and nothing else.
   */
  async sendVoiceNote(
    chatId: string,
    audio: Uint8Array,
    opts: SendVoiceNoteOptions,
  ): Promise<DeliveryResult> {
    if (!this.sock) return { ok: false, error: 'Not connected' };

    const sock = this.sock as {
      sendMessage: (
        jid: string,
        content: unknown,
        opts?: unknown,
      ) => Promise<{ key: { id?: string } }>;
    };

    try {
      const sent = await sock.sendMessage(chatId, {
        audio: Buffer.from(audio),
        mimetype: opts.mimeType,
        ptt: true,
      });
      return { ok: true, messageId: sent.key.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return { ok: this.sock !== null && this.botJid !== '' };
  }
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
