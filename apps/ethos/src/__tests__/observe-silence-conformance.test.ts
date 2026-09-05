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
const SLACK_WEB_UI_BASE = 'https://ethos.example.com';

vi.mock('@slack/bolt', () => {
  // Every registration is captured under a stable key, not just the two the
  // message path uses. The keys ARE the adapter's own registration list, which
  // is what lets the sweep at the bottom of this file enumerate handlers
  // instead of trusting a hand-written roster.
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
    command(name: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`command:${name}`, fn);
    }
    view(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`view:${id}`, fn);
    }
    action(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`action:${id}`, fn);
    }
    shortcut(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`shortcut:${id}`, fn);
    }
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

/**
 * Start a Slack adapter with EVERY optional dependency wired, so every handler
 * the adapter is capable of registering actually registers.
 *
 * `binding` gates `member_joined_channel`; `webUiBaseUrl` gates `link_shared`;
 * `sessionUnfurl` is what lets an unfurl resolve to a real card rather than
 * being skipped. A partially-wired adapter would register a smaller handler
 * set, and the sweep below would then be enumerating — and passing — a subset
 * of production.
 */
async function startSlack(mode: Mode): Promise<{ envelopes: InboundMessage[] }> {
  slackCalls.length = 0;
  slackHandlers.clear();

  const adapter = new SlackAdapter({
    botToken: 'xoxb-1',
    // Socket Mode is the default transport and the constructor refuses without it.
    appToken: 'xapp-1',
    botKey: 'prod-slack',
    defaultChannelMode: mode,
    binding: { type: 'personality', name: 'sitewatcher' },
    // `/ethos` is default-deny (authz.ts, CHS-001). Without an allowlisted
    // invoker the slash handler short-circuits on the refusal and never reaches
    // a subcommand, which would make this sweep's `command:/ethos` case pass
    // vacuously against the exact bug it is here to catch.
    allowedUsers: [SLACK_INVOKER],
    webUiBaseUrl: SLACK_WEB_UI_BASE,
    sessionUnfurl: {
      lookupSession: async (id: string) => ({
        id,
        personalityName: 'sitewatcher',
        lastActivity: new Date(0),
      }),
    },
  });
  const envelopes: InboundMessage[] = [];
  adapter.onMessage((m) => envelopes.push(m));
  await adapter.start();
  // Everything above is startup. Only the handlers are on trial.
  slackCalls.length = 0;
  return { envelopes };
}

async function deliverSlack(mode: Mode): Promise<Delivery> {
  const { envelopes } = await startSlack(mode);

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

// ---------------------------------------------------------------------------
// Slack — EVERY registered handler, not just the message path
// ---------------------------------------------------------------------------

// The table above drives exactly one shape per adapter: a plain unaddressed
// group message. That is the shape the four historical receipt-reaction bugs
// had, and it is the shape this file was built around — which is precisely why
// three Slack handlers that put content into an observed channel survived it:
//
//   `member_joined_channel` posted a public greeting on every invite, with the
//   mode interpolated as display text and never consulted as a gate;
//   `/ethos ask` submitted a full agent turn (answer posted by the gateway)
//   plus an `in_channel` acknowledgement; and `link_shared` called
//   `chat.unfurl` with no mode check at all.
//
// None of them is on the message path. So this sweep does not drive a shape —
// it drives the ADAPTER'S OWN REGISTRATION LIST. `MockApp` records every
// `message`/`event`/`command`/`action`/`view`/`shortcut` call the adapter makes
// under a stable key, so `slackHandlers.keys()` after `start()` is the real
// roster, discovered rather than remembered.
//
// A driver per key supplies the payload that key's handler expects, because no
// generic payload can stand in for a `view_submission` and a `link_shared` at
// once. `enrollment` below closes that gap: the roster and the driver table
// must match exactly, so a NEW registration fails this file by name until
// someone drives it and proves it silent. That is the part that stops
// recurrence — the next handler is covered by the enumeration, and the only
// way past the gate is to write its case.

/** Bolt args are shaped per registration kind; a driver builds one payload. */
type HandlerDriver = (handler: (args: unknown) => Promise<void>) => Promise<void>;

const SLACK_CHANNEL = 'C_SITE_7';
const SLACK_INVOKER = 'U_STRANGER';

/** A Bolt `client` that records into the same log the adapter's own does. */
function boltClient(): unknown {
  return recordingClient(slackCalls);
}

/** Records the ack Slack requires on every interactive payload. */
async function ack(): Promise<void> {
  slackCalls.push('ack');
}

/** Records the slash-command reply BY VISIBILITY — `in_channel` is a post. */
async function respond(args: { response_type?: string }): Promise<void> {
  slackCalls.push(`respond(${args.response_type ?? 'unknown'})`);
}

/** A `block_actions` payload — the shape both the approval and clarify
 *  handlers narrow. */
function blockActions(actionId: string): unknown {
  return {
    ack,
    body: {
      user: { id: SLACK_INVOKER },
      channel: { id: SLACK_CHANNEL },
      message: { ts: '1699000000.000100' },
      trigger_id: 'T1',
    },
    action: { action_id: actionId, value: 'v1' },
  };
}

const buttonDriver =
  (actionId: string): HandlerDriver =>
  async (handler) => {
    await handler(blockActions(actionId));
  };

const SLACK_HANDLER_DRIVERS: Record<string, HandlerDriver> = {
  message: async (handler) => {
    await handler({
      message: {
        ts: '1699000000.000100',
        text: 'concrete pour slipped to thursday',
        user: SLACK_INVOKER,
        channel: SLACK_CHANNEL,
        channel_type: 'channel',
      },
    });
  },
  'event:app_mention': async (handler) => {
    await handler({
      event: {
        channel: SLACK_CHANNEL,
        user: SLACK_INVOKER,
        text: '<@UBOT> are we on track?',
        ts: '1699000000.000200',
      },
      client: boltClient(),
    });
  },
  // The bot itself being invited — the greeting path.
  'event:member_joined_channel': async (handler) => {
    await handler({
      event: { user: 'UBOT', channel: SLACK_CHANNEL },
      client: boltClient(),
    });
  },
  // An Ethos link pasted into the room — the unfurl path.
  'event:link_shared': async (handler) => {
    await handler({
      event: {
        channel: SLACK_CHANNEL,
        message_ts: '1699000000.000300',
        links: [{ url: `${SLACK_WEB_UI_BASE}/sessions/s-1` }],
      },
      client: boltClient(),
    });
  },
  // The App Home tab. Per-user by construction, so its `views.publish` is
  // allowlisted below — but it is driven, so a handler that started posting
  // into a CHANNEL from here would be caught.
  'event:app_home_opened': async (handler) => {
    await handler({ event: { user: SLACK_INVOKER, tab: 'home' }, client: boltClient() });
  },
  // `/ethos ask` specifically: the subcommand that used to submit a turn whose
  // answer the gateway posts into the room, plus an `in_channel` ack.
  'command:/ethos': async (handler) => {
    await handler({
      command: {
        command: '/ethos',
        text: 'ask what is the pour date',
        channel_id: SLACK_CHANNEL,
        user_id: SLACK_INVOKER,
        trigger_id: 'T1',
      },
      ack,
      respond,
    });
  },
  'action:ethos_approval_allow': buttonDriver('ethos_approval_allow'),
  'action:ethos_approval_deny': buttonDriver('ethos_approval_deny'),
  'action:ethos_clarify_choice': buttonDriver('ethos_clarify_choice'),
  'action:ethos_clarify_cancel': buttonDriver('ethos_clarify_cancel'),
  'action:ethos_clarify_answer': buttonDriver('ethos_clarify_answer'),
  'action:home:refresh': async (handler) => {
    await handler({ ack, body: { user: { id: SLACK_INVOKER } }, client: boltClient() });
  },
  'view:ethos_clarify_modal': async (handler) => {
    await handler({
      ack,
      body: {
        user: { id: SLACK_INVOKER },
        view: {
          callback_id: 'ethos_clarify_modal',
          private_metadata: '',
          state: { values: {} },
        },
      },
    });
  },
};

/**
 * Calls the ROOM cannot see. Everything else is content in a channel.
 *
 * Each entry is here on the same test the table above applies: could a person
 * sitting in the observed channel tell it happened? A Web API read and a
 * protocol ack produce nothing; an `ephemeral` reply and a Home-tab publish
 * render for one viewer, which is exactly how the operator still learns what
 * silenced the room. `respond(in_channel)` is deliberately NOT here — it is a
 * public post, and it is half of the `/ethos ask` bug.
 */
const SLACK_INVISIBLE: ReadonlySet<string> = new Set([
  'ack',
  'respond(ephemeral)',
  'users.info',
  'views.publish',
]);

/** Drive one registered handler in `mode` and return what the room could see. */
async function sweepSlackHandler(key: string, mode: Mode): Promise<string[]> {
  await startSlack(mode);
  const handler = slackHandlers.get(key);
  if (!handler) throw new Error(`adapter registered no handler for ${key}`);
  const driver = SLACK_HANDLER_DRIVERS[key];
  if (!driver) throw new Error(`no driver for registered handler ${key}`);
  slackCalls.length = 0;
  await driver(handler);
  // Slash and unfurl work is awaited inside the handlers; the receipt reaction
  // and file enrichment are fired without awaiting, so let the microtask queue
  // drain before reading the log or an `all`-mode control would race.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return slackCalls.filter((c) => !SLACK_INVISIBLE.has(c));
}

/** The roster, as the adapter itself registered it. */
async function registeredSlackHandlers(): Promise<string[]> {
  await startSlack('observe');
  return [...slackHandlers.keys()].sort();
}

describe('platform-slack — every registered handler is silent in observe mode', () => {
  it('drives every handler the adapter registers, and no phantom ones', async () => {
    // Failing here means the Slack adapter registered a handler this file does
    // not drive — or that a driver outlived its registration. Add the key to
    // SLACK_HANDLER_DRIVERS with the payload its handler expects; do NOT add an
    // exemption, because the three bugs this sweep exists to catch were all in
    // handlers that were already registered and simply never invoked here.
    expect(await registeredSlackHandlers()).toEqual(Object.keys(SLACK_HANDLER_DRIVERS).sort());
  });

  it.each(Object.keys(SLACK_HANDLER_DRIVERS))(
    '%s puts nothing into an observed room',
    async (key) => {
      expect(await sweepSlackHandler(key, 'observe')).toEqual([]);
    },
  );

  // The control. Without it the sweep above would pass just as well against
  // handlers that were never invoked, payloads that never matched, and an
  // adapter that answers nothing — proving no silence at all. These three are
  // exactly the handlers that were putting content into observed rooms, so
  // under an answering mode each one must still be seen doing it.
  // Sequential, never `Promise.all`: `startSlack` resets the module-global
  // handler map and call log, so concurrent sweeps read each other's calls —
  // which is itself a way this control can pass while proving nothing.
  it.each(['event:member_joined_channel', 'command:/ethos', 'event:link_shared'])(
    '%s still puts content into an answering room',
    async (key) => {
      expect(await sweepSlackHandler(key, 'all')).not.toEqual([]);
    },
  );
});
