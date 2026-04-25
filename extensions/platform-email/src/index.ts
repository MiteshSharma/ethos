import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailAdapterConfig {
  imapHost: string;
  imapPort: number;
  user: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  /** Use TLS on the SMTP connection. Default true for port 465, false for 587. */
  smtpSecure?: boolean;
  /** Polling interval in ms. Default 60_000. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/^re:\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// chatId encodes both sender and subject so each subject thread is a separate
// gateway lane (and therefore a separate agent session).
function makeChatId(from: string, subject: string): string {
  return `${from}:${slugify(subject)}`;
}

// ---------------------------------------------------------------------------
// Thread state — persists reply-threading info between poll → send
// ---------------------------------------------------------------------------

interface ThreadState {
  to: string;
  replySubject: string;
  inReplyTo?: string;
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

export class EmailAdapter implements PlatformAdapter {
  readonly id = 'email';
  readonly displayName = 'Email';
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 100_000;

  private readonly config: EmailAdapterConfig;
  private readonly pollIntervalMs: number;
  private messageHandler?: (msg: InboundMessage) => void;
  private pollTimer?: ReturnType<typeof setInterval>;

  // chatId → thread state needed to reply correctly
  private readonly threads = new Map<string, ThreadState>();

  // Injected in constructor — allows tests to provide mocks
  private readonly createImapClient: (cfg: EmailAdapterConfig) => ImapFlow;
  private readonly createTransporter: (cfg: EmailAdapterConfig) => nodemailer.Transporter;

  constructor(
    config: EmailAdapterConfig,
    overrides?: {
      createImapClient?: (cfg: EmailAdapterConfig) => ImapFlow;
      createTransporter?: (cfg: EmailAdapterConfig) => nodemailer.Transporter;
    },
  ) {
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.createImapClient = overrides?.createImapClient ?? defaultImapClient;
    this.createTransporter = overrides?.createTransporter ?? defaultTransporter;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // First poll immediately, then schedule
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Send — called by Gateway with chatId and response text
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const thread = this.threads.get(chatId);
    if (!thread) {
      return { ok: false, error: `No thread state for chatId: ${chatId}` };
    }

    const transporter = this.createTransporter(this.config);

    try {
      const info = await transporter.sendMail({
        from: this.config.user,
        to: thread.to,
        subject: thread.replySubject,
        ...(thread.inReplyTo ? { inReplyTo: thread.inReplyTo, references: thread.inReplyTo } : {}),
        text: message.text,
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Message subscription
  // ---------------------------------------------------------------------------

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now();
    const client = this.createImapClient(this.config);
    try {
      await client.connect();
      await client.logout();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Poll — opens INBOX, fetches unseen messages, emits InboundMessage events
  // ---------------------------------------------------------------------------

  async poll(): Promise<void> {
    if (!this.messageHandler) return;

    const client = this.createImapClient(this.config);

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const uidResult = await client.search({ seen: false }, { uid: true });
        const uids = Array.isArray(uidResult) ? uidResult : [];
        if (uids.length === 0) return;

        for await (const msg of client.fetch(
          uids as number[],
          { source: true, uid: true },
          { uid: true },
        )) {
          if (!msg.source) continue;
          try {
            await this.processMessage(msg.source, msg.uid, client);
          } catch {
            // Skip malformed messages rather than crashing the poll loop
          }
        }
      } finally {
        lock.release();
      }
    } catch {
      // IMAP errors are transient — log silently and retry next poll
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  private async processMessage(source: Buffer, uid: number, client: ImapFlow): Promise<void> {
    const parsed = await simpleParser(source);

    const from = parsed.from?.value?.[0]?.address ?? '';
    const subject = parsed.subject ?? '(no subject)';
    const text = (parsed.text ?? '').trim();

    if (!from || !text) return;

    const chatId = makeChatId(from, subject);

    this.threads.set(chatId, {
      to: from,
      replySubject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
      inReplyTo: parsed.messageId ?? undefined,
    });

    this.messageHandler?.({
      platform: 'email',
      chatId,
      userId: from,
      username: parsed.from?.value?.[0]?.name ?? from,
      text,
      isDm: true,
      isGroupMention: false,
      raw: parsed,
    });

    // Mark seen so we don't re-process on the next poll
    await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
  }
}

// ---------------------------------------------------------------------------
// Default factory functions (replaced by mocks in tests)
// ---------------------------------------------------------------------------

function defaultImapClient(cfg: EmailAdapterConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
}

function defaultTransporter(cfg: EmailAdapterConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure ?? cfg.smtpPort === 465,
    auth: { user: cfg.user, pass: cfg.password },
  });
}
