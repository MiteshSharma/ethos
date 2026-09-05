// Observe-mode silence conformance — the cross-adapter gate.
//
// `InboundMessage.recordOnly` (packages/types/src/platform.ts) is an optional
// boolean on the general inbound envelope, so the silence contract it stands
// for is enforced nowhere central: every adapter independently has to (a) stamp
// the flag and (b) suppress every visible acknowledgement on the way out. That
// is not a hypothetical risk. During plan/phases/ambient-group-monitoring.md
// the SAME bug — "the adapter still put a receipt reaction on a record-only
// message" — was found and fixed four separate times, once per adapter:
// Telegram's reaction, Slack's `reactions.add`, WhatsApp's 👀 and Discord's 👀.
// A fifth adapter compiles fine while violating the contract.
//
// So this file is a table, not a suite. Each entry drives ONE adapter's REAL
// inbound path in `observe` mode with a recording platform client, and asserts
// the two halves of the contract together:
//
//   1. the envelope that leaves the adapter is stamped `recordOnly: true`, and
//   2. the adapter made no visible call to the platform while producing it.
//
// The second half is asserted against a call LOG, not against named `vi.fn()`
// spies: a new visible call an adapter starts making is recorded by name and
// fails the case, which is the drift the per-adapter suites cannot see. A call
// to a method the fake does not implement throws, which fails it too.
//
// And `enrollment` below discovers, from disk, every adapter that stamps
// `recordOnly` at all and requires it to appear in this table — so adapter #5
// cannot join the silence contract without a case here proving it is silent.
//
// This lives in `apps/` because it is the only layer allowed to import every
// adapter (ARCHITECTURE.md §II: types <- core <- extensions <- apps). The
// contract-level half of this gate is in
// packages/types/src/__tests__/channel-conformance.test.ts, which cannot import
// an adapter and therefore cannot assert any of the above.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Recording platform client
// ---------------------------------------------------------------------------

/** Dotted names of the platform calls an adapter made, in order. */
type CallLog = string[];

/**
 * A platform client that records EVERY method call by dotted name and resolves
 * to a canned result.
 *
 * The point is the open set: `reactions.add`, `sendMessage`, `setMessageReaction`
 * and anything an adapter starts calling tomorrow are all recorded the same
 * way, without this file having to know the method exists. A hand-listed spy
 * per method only catches the noise we already thought of.
 */
function recordingClient(log: CallLog, results: Record<string, unknown> = {}, path = ''): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      // `then` must stay absent or awaiting a returned promise recurses.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return recordingClient(log, results, path ? `${path}.${prop}` : prop);
    },
    apply() {
      log.push(path);
      return Promise.resolve(results[path] ?? {});
    },
  });
}

// ---------------------------------------------------------------------------
// grammy (Telegram)
// ---------------------------------------------------------------------------

const telegramCalls: CallLog = [];
const telegramHandlers: Record<string, ((ctx: unknown) => void)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    // Privacy mode OFF, so the adapter's own startup warning stays quiet and
    // every call in the log is one the message path made.
    api = recordingClient(telegramCalls, {
      getMe: {
        id: 1,
        is_bot: true,
        first_name: 'Bot',
        username: 'sitewatcher',
        can_read_all_group_messages: true,
      },
    });
    on(event: string, handler: (ctx: unknown) => void) {
      if (!telegramHandlers[event]) telegramHandlers[event] = [];
      telegramHandlers[event].push(handler);
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard };
});

// ---------------------------------------------------------------------------
// @slack/bolt
// ---------------------------------------------------------------------------

const slackCalls: CallLog = [];
const slackHandlers = new Map<string, (args: unknown) => Promise<void>>();

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = recordingClient(slackCalls, { 'auth.test': { user_id: 'UBOT', user: 'ethos' } });
    async start() {}
    async stop() {}
    message(fn: (args: unknown) => Promise<void>) {
      slackHandlers.set('message', fn);
    }
    event(name: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`event:${name}`, fn);
    }
    command() {}
    view() {}
    action() {}
    shortcut() {}
    error() {}
    use() {}
  }
  return { default: { App: MockApp } };
});

// ---------------------------------------------------------------------------
// @whiskeysockets/baileys (WhatsApp)
// ---------------------------------------------------------------------------

const whatsappCalls: CallLog = [];
const whatsappHandlers = new Map<string, (payload: unknown) => unknown>();
const WA_BOT_JID = '15551234567:12@s.whatsapp.net';
const WA_GROUP = '120363000000000000@g.us';
const WA_PARTICIPANT = '15559999999@s.whatsapp.net';

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => ({
    ev: {
      on: (event: string, handler: (payload: unknown) => unknown) => {
        whatsappHandlers.set(event, handler);
      },
    },
    user: { id: WA_BOT_JID },
    authState: { creds: { registered: true } },
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      // Recorded by the shape of what it puts in the room, so a reaction and a
      // text reply are distinguishable in the failure message.
      whatsappCalls.push(`sendMessage(${Object.keys(content).sort().join(',')})->${jid}`);
      return { key: { id: 'sent-1' } };
    },
  }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: vi.fn(async () => Buffer.from([1, 2, 3, 4])),
}));

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

const { TelegramAdapter } = await import('../../../../extensions/platform-telegram/src/index');
const { SlackAdapter } = await import('../../../../extensions/platform-slack/src/index');
const { WhatsAppAdapter } = await import('../../../../extensions/platform-whatsapp/src/index');
const { registerMessageHandler } = await import(
  '../../../../extensions/platform-discord/src/events/messages'
);

/** What one adapter's `observe`-mode delivery produced. */
interface Delivery {
  /** Envelopes the adapter forwarded to the gateway. */
  envelopes: InboundMessage[];
  /** Platform calls made while handling the message — startup excluded. */
  calls: CallLog;
}

/** The two modes this file drives: silent, and the answering control. */
type Mode = 'observe' | 'all';

interface AdapterCase {
  /** The `extensions/platform-*` directory this case covers. */
  pkg: string;
  /**
   * Platform calls that are legitimate in observe mode because the room cannot
   * see them. Reads only — a write belongs in no allowlist.
   */
  invisibleReads: string[];
  /** Start the adapter in `mode` and deliver one unaddressed group post. */
  deliver(mode: Mode): Promise<Delivery>;
}

// --- Telegram ---------------------------------------------------------------

async function deliverTelegram(mode: Mode): Promise<Delivery> {
  telegramCalls.length = 0;
  for (const key of Object.keys(telegramHandlers)) delete telegramHandlers[key];

  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: 'sitewatcher',
    defaultChannelMode: mode,
  });
  const envelopes: InboundMessage[] = [];
  adapter.onMessage((m) => envelopes.push(m));
  await adapter.start();
  // Everything above is startup. Only the message path is on trial.
  telegramCalls.length = 0;

  for (const h of telegramHandlers.message ?? []) {
    h({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      message: {
        text: 'concrete pour slipped to thursday',
        caption: undefined,
        message_id: 7,
        date: 1_699_000_000,
        reply_to_message: null,
      },
      me: { username: 'sitewatcher' },
    });
  }
  return { envelopes, calls: [...telegramCalls] };
}

// --- Slack ------------------------------------------------------------------

async function deliverSlack(mode: Mode): Promise<Delivery> {
  slackCalls.length = 0;
  slackHandlers.clear();

  const adapter = new SlackAdapter({
    botToken: 'xoxb-1',
    // Socket Mode is the default transport and the constructor refuses without it.
    appToken: 'xapp-1',
    botKey: 'prod-slack',
    defaultChannelMode: mode,
  });
  const envelopes: InboundMessage[] = [];
  adapter.onMessage((m) => envelopes.push(m));
  await adapter.start();
  slackCalls.length = 0;

  const handler = slackHandlers.get('message');
  if (!handler) throw new Error('adapter registered no message handler');
  await handler({
    message: {
      ts: '1699000000.000100',
      text: 'concrete pour slipped to thursday',
      user: 'U_STRANGER',
      channel: 'C_SITE_7',
      channel_type: 'channel',
    },
  });
  return { envelopes, calls: [...slackCalls] };
}

// --- WhatsApp ---------------------------------------------------------------

async function deliverWhatsApp(mode: Mode): Promise<Delivery> {
  whatsappCalls.length = 0;
  whatsappHandlers.clear();

  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-observe-silence-conformance',
    botKey: 'bot1',
    denyUnknown: false,
    defaultMode: mode,
  });
  const envelopes: InboundMessage[] = [];
  adapter.onMessage((m) => envelopes.push(m));
  await adapter.start();
  // `botJid` is only known once the connection opens.
  whatsappHandlers.get('connection.update')?.({ connection: 'open' });
  whatsappCalls.length = 0;

  const upsert = whatsappHandlers.get('messages.upsert');
  if (!upsert) throw new Error('adapter registered no messages.upsert handler');
  await upsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: WA_GROUP, fromMe: false, id: 'wa-1', participant: WA_PARTICIPANT },
        message: { conversation: 'concrete pour slipped to thursday' },
        messageTimestamp: 1_699_000_000,
      },
    ],
  });
  return { envelopes, calls: [...whatsappCalls] };
}

// --- Discord ----------------------------------------------------------------

async function deliverDiscord(mode: Mode): Promise<Delivery> {
  const calls: CallLog = [];
  const handlers = new Map<string, (message: unknown) => Promise<void>>();
  const client = {
    on: (event: string, handler: (message: unknown) => Promise<void>) => {
      handlers.set(event, handler);
    },
    user: undefined,
  };
  const envelopes: InboundMessage[] = [];

  registerMessageHandler({
    client: client as never,
    botKey: 'bot-1',
    defaultChannelMode: mode,
    receiptReaction: '👀',
    onMessage: (msg: InboundMessage) => envelopes.push(msg),
    onReceipt: () => {},
  });

  const handler = handlers.get('messageCreate');
  if (!handler) throw new Error('adapter registered no messageCreate handler');
  await handler({
    id: 'm1',
    channelId: 'C_SITE_7',
    content: 'concrete pour slipped to thursday',
    createdTimestamp: 1_699_000_000_000,
    author: { id: 'U_STRANGER', username: 'sitemanager', bot: false },
    attachments: new Map(),
    mentions: { has: () => false, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
      parentId: null,
      messages: {
        fetch: async () => {
          calls.push('channel.messages.fetch');
          return new Map();
        },
      },
    },
    react: async (emoji: string) => {
      calls.push(`react(${emoji})`);
    },
  });
  return { envelopes, calls };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const CASES: AdapterCase[] = [
  { pkg: 'platform-telegram', invisibleReads: [], deliver: deliverTelegram },
  {
    pkg: 'platform-slack',
    // Resolving the sender's display name for the transcript row. A Web API
    // read: it posts nothing and nobody in the channel can tell it happened.
    invisibleReads: ['users.info'],
    deliver: deliverSlack,
  },
  { pkg: 'platform-whatsapp', invisibleReads: [], deliver: deliverWhatsApp },
  {
    pkg: 'platform-discord',
    // Reading prior history to seed the transcript is invisible to the room,
    // and observe mode is exactly where a context-blind first entry hurts.
    invisibleReads: ['channel.messages.fetch'],
    deliver: deliverDiscord,
  },
];

describe.each(CASES)('$pkg — observe mode is silent', (adapterCase) => {
  const visibleCalls = (d: Delivery): string[] =>
    d.calls.filter((c) => !adapterCase.invisibleReads.includes(c));

  it('forwards the message stamped record-only', async () => {
    const { envelopes } = await adapterCase.deliver('observe');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.recordOnly).toBe(true);
  });

  it('puts nothing visible back into the room', async () => {
    // A receipt reaction is the bot answering — visibly, to the whole room,
    // several hundred times a day. Silent means silent.
    expect(visibleCalls(await adapterCase.deliver('observe'))).toEqual([]);
  });

  // The control, and the reason the case above is not vacuous. Without it this
  // table would pass just as well against a recorder that observes nothing, an
  // adapter that answers nothing, or a message that never arrives — and would
  // look like protection while proving none. Under `all` the adapter SHOULD
  // acknowledge, so this pins the exact call the case above requires to be
  // absent: whatever each adapter's version of the four real bugs put in the
  // room, this is the recorder seeing it.
  it('records the acknowledgement it suppresses, when the mode says to answer', async () => {
    const answering = await adapterCase.deliver('all');

    expect(answering.envelopes[0]?.recordOnly).toBe(false);
    expect(visibleCalls(answering).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Every `extensions/platform-*` package whose SHIPPED source mentions
 * `recordOnly` — i.e. every adapter that has joined the silence contract.
 *
 * Discovered from disk rather than hand-listed, because a hand-listed roster
 * is exactly what a fifth adapter would forget to join.
 */
function adaptersStampingRecordOnly(): string[] {
  const extensions = join(REPO_ROOT, 'extensions');
  const found: string[] = [];
  for (const pkg of readdirSync(extensions)) {
    if (!pkg.startsWith('platform-')) continue;
    let src: string[];
    try {
      src = readdirSync(join(extensions, pkg, 'src'), { recursive: true }).map(String);
    } catch {
      continue; // no src/ — not an adapter package
    }
    const stamps = src.some(
      (rel) =>
        rel.endsWith('.ts') &&
        !rel.includes('__tests__') &&
        readFileSync(join(extensions, pkg, 'src', rel), 'utf8').includes('recordOnly'),
    );
    if (stamps) found.push(pkg);
  }
  return found.sort();
}

describe('enrollment', () => {
  it('every adapter in the silence contract has a case in the table above', () => {
    // Failing here means an adapter started stamping `recordOnly` without a
    // case proving it stays silent. Add one to CASES — do not add the package
    // to an exemption list, because the four bugs this file exists to catch
    // were all in adapters that were already "enrolled".
    expect(adaptersStampingRecordOnly()).toEqual(CASES.map((c) => c.pkg).sort());
  });
});
