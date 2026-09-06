// The three Slack handlers that could put content into an observed channel
// without ever consulting the channel mode.
//
// `docs/content/platforms/slack.md` promises that under `observe` "the bot
// reads the channel and says nothing in it". Three registered handlers
// contradicted that, and none of them was on the message path that
// `apps/ethos/src/__tests__/observe-silence-conformance.test.ts` drove:
//
//   1. `member_joined_channel` — a public `chat.postMessage` greeting on every
//      invite. The mode was interpolated into the greeting as DISPLAY TEXT and
//      was never a gate, so `defaultChannelMode: observe` announced the bot in
//      every room it joined.
//   2. `/ethos ask` — the envelope was stamped `isGroupMention: true` with no
//      `recordOnly`, explicitly commented "channel-mode is bypassed", so the
//      agent ran a full turn and the gateway posted the answer into the room —
//      plus an `in_channel` acknowledgement, a second public post.
//   3. `link_shared` — `chat.unfurl` posted a card with no mode check at all.
//
// Every case here asserts on RECORDED PLATFORM CALLS, not on a return value: a
// handler that decides correctly and posts anyway is the bug, and only the call
// log can tell the difference. Each silent case is paired with an answering
// control, because "no calls" also passes against a handler that was never
// invoked, a mode that never resolved, and an event that never arrived.

import { describe, expect, it } from 'vitest';
import { dispatch, type SlashContext } from '../commands/index';
import { registerLinkEvents } from '../events/links';
import { registerMemberEvents } from '../events/members';

/** Dotted names of the platform calls a handler made, in order. */
type CallLog = string[];

const CHANNEL = 'C_SITE_7';
const USER = 'U_OPERATOR';

/**
 * The two silent modes and the two answering ones.
 *
 * `obserev` is the typo an operator actually types when reaching for
 * `observe`. It is not a mode this build can read, so it fails closed like
 * `observe` — and the test below proves the operator still learns the string
 * verbatim from a surface the room cannot see.
 */
/**
 * `regex_match` joins them as of the per-adapter `supportedModes` change: it is
 * a REAL mode — on Telegram — that Slack's enum does not contain, so a line
 * copied from a Telegram override file is unreadable here and must fail closed
 * exactly like the typo. Under the old hard-coded union of all four enums it
 * was "recognised", and every handler below fell through to the answering
 * `isGroupMention` branch while the message path recorded nothing.
 */
const SILENT = ['observe', 'obserev', 'regex_match'] as const;
const ANSWERING = ['mention_only', 'all'] as const;

// ---------------------------------------------------------------------------
// 1. member_joined_channel
// ---------------------------------------------------------------------------

/** Register the greeting handler and deliver one self-join under `mode`. */
async function deliverSelfJoin(mode: string): Promise<CallLog> {
  const calls: CallLog = [];
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  const app = {
    event: (name: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`event:${name}`, fn);
    },
  };

  registerMemberEvents(app as never, {
    selfUserId: 'UBOT',
    binding: { type: 'personality', name: 'sitewatcher' },
    resolveChannelMode: () => mode,
  });

  const handler = handlers.get('event:member_joined_channel');
  if (!handler) throw new Error('registerMemberEvents registered no handler');
  await handler({
    event: { user: 'UBOT', channel: CHANNEL },
    client: {
      chat: {
        postMessage: async (args: { text?: string }) => {
          calls.push(`chat.postMessage(${args.text ?? ''})`);
          return {};
        },
      },
    },
  });
  return calls;
}

describe('member_joined_channel — the invite greeting', () => {
  for (const mode of SILENT) {
    it(`posts nothing into a channel in \`${mode}\` mode`, async () => {
      expect(await deliverSelfJoin(mode)).toEqual([]);
    });
  }

  for (const mode of ANSWERING) {
    it(`still greets in \`${mode}\` mode, naming the binding and the mode`, async () => {
      const calls = await deliverSelfJoin(mode);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('sitewatcher');
      expect(calls[0]).toContain(mode);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. /ethos ask
// ---------------------------------------------------------------------------

interface AskOutcome {
  /** Agent turns submitted — each one becomes a gateway `chat.postMessage`. */
  submitted: string[];
  /** `in_channel` is a public post; `ephemeral` only the invoker sees. */
  responseType: 'ephemeral' | 'in_channel';
  text: string;
}

function slashCtx(mode: string, submitted: string[]): SlashContext {
  return {
    binding: { type: 'personality', name: 'sitewatcher' },
    defaultChannelMode: 'mention_only',
    // A stored override is the only way an unreadable mode reaches the
    // resolver; the store preserves it verbatim by design.
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub, as in triage.test.ts
    channelOverrides: { get: () => ({ mode }) } as any,
    allowedUsers: [USER],
    submitAgentTurn: async (input) => {
      submitted.push(input.text);
    },
  };
}

/** Drive the REAL slash dispatcher (authz included) with `/ethos ask`. */
async function runAsk(
  mode: string,
  text = 'ask what is the pour date',
  channel: { id: string; name?: string } = { id: CHANNEL },
): Promise<AskOutcome> {
  const submitted: string[] = [];
  const response = await dispatch(
    {
      command: '/ethos',
      text,
      channel_id: channel.id,
      channel_name: channel.name,
      user_id: USER,
      trigger_id: 'T1',
    },
    slashCtx(mode, submitted),
  );
  return { submitted, responseType: response.responseType, text: response.text };
}

describe('/ethos ask — an explicit command into a room promised silence', () => {
  for (const mode of SILENT) {
    it(`submits no agent turn in \`${mode}\` mode`, async () => {
      // The turn is the public post: its answer returns through the gateway's
      // ordinary outbound path, into the channel, in front of everyone.
      expect((await runAsk(mode)).submitted).toEqual([]);
    });

    it(`refuses ephemerally in \`${mode}\` mode — the room sees nothing`, async () => {
      const outcome = await runAsk(mode);

      expect(outcome.responseType).toBe('ephemeral');
      expect(outcome.text).toContain(mode);
    });
  }

  for (const mode of ANSWERING) {
    it(`still runs in \`${mode}\` mode and acknowledges in channel`, async () => {
      const outcome = await runAsk(mode);

      expect(outcome.submitted).toEqual(['what is the pour date']);
      expect(outcome.responseType).toBe('in_channel');
    });
  }
});

// ---------------------------------------------------------------------------
// 3. link_shared
// ---------------------------------------------------------------------------

const BASE = 'https://ethos.example.com';

interface UnfurlOutcome {
  calls: CallLog;
  /** Reader lookups — a silent room should not even cost these. */
  lookups: string[];
}

async function deliverLinkShared(mode: string, channel = CHANNEL): Promise<UnfurlOutcome> {
  const calls: CallLog = [];
  const lookups: string[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  const app = {
    event: (name: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`event:${name}`, fn);
    },
  };

  registerLinkEvents(app as never, {
    webUiBaseUrl: BASE,
    resolveChannelMode: () => mode,
    session: {
      lookupSession: async (id: string) => {
        lookups.push(`lookupSession:${id}`);
        return { id, personalityName: 'sitewatcher', lastActivity: new Date(0) };
      },
    },
  });

  const handler = handlers.get('event:link_shared');
  if (!handler) throw new Error('registerLinkEvents registered no handler');
  await handler({
    event: {
      channel,
      message_ts: '1699000000.000100',
      links: [{ url: `${BASE}/sessions/s-1` }],
    },
    client: {
      chat: {
        unfurl: async () => {
          calls.push('chat.unfurl');
          return {};
        },
      },
    },
  });
  return { calls, lookups };
}

describe('link_shared — an unfurl is content in the channel', () => {
  for (const mode of SILENT) {
    it(`unfurls nothing in \`${mode}\` mode, and spends no lookup doing it`, async () => {
      const outcome = await deliverLinkShared(mode);

      expect(outcome.calls).toEqual([]);
      expect(outcome.lookups).toEqual([]);
    });
  }

  for (const mode of ANSWERING) {
    it(`still unfurls in \`${mode}\` mode`, async () => {
      const outcome = await deliverLinkShared(mode);

      expect(outcome.calls).toEqual(['chat.unfurl']);
      expect(outcome.lookups).toEqual(['lookupSession:s-1']);
    });
  }
});

// ---------------------------------------------------------------------------
// An unreadable mode stays diagnosable
// ---------------------------------------------------------------------------

// Gating the greeting on the mode costs the operator the one place that used to
// name the governing mode unprompted. That is deliberate — a public post is not
// a diagnostic channel — so the replacement has to be proven, not assumed:
// every surface below renders the raw stored string, and every one of them is
// `ephemeral`, i.e. visible to the operator who asked and to nobody else in the
// room. `home/view.ts` renders the same value per-channel in the App Home tab,
// which is per-user by construction.
describe('an unreadable stored mode stays diagnosable on ungated surfaces', () => {
  const TYPO = 'obserev';

  async function runSlash(text: string): Promise<{ type: string; text: string }> {
    const response = await dispatch(
      { command: '/ethos', text, channel_id: CHANNEL, user_id: USER, trigger_id: 'T1' },
      slashCtx(TYPO, []),
    );
    return { type: response.responseType, text: response.text };
  }

  it('`/ethos channel-mode show` names the typo verbatim, ephemerally', async () => {
    const shown = await runSlash('channel-mode show');

    expect(shown.text).toContain(TYPO);
    expect(shown.type).toBe('ephemeral');
  });

  it('`/ethos help` names the typo verbatim, ephemerally', async () => {
    const shown = await runSlash('help');

    expect(shown.text).toContain(TYPO);
    expect(shown.type).toBe('ephemeral');
  });

  it('the `/ethos ask` refusal names the typo verbatim, ephemerally', async () => {
    const shown = await runSlash('ask why has this room gone quiet');

    expect(shown.text).toContain(TYPO);
    expect(shown.type).toBe('ephemeral');
  });

  it('and the greeting that used to carry it is the surface that went silent', async () => {
    // The trade, stated as a test: this is what the three cases above replace.
    expect(await deliverSelfJoin(TYPO)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The other half of the promise: a DM is not a room
// ---------------------------------------------------------------------------

// `docs/content/platforms/slack.md` tells the reader "to ask this bot something
// while a channel is observed, DM it". That sentence was false for the
// deployment it was written for. `canSpeakInChannel` hard-coded `isDm: false`,
// discarding `evaluateChannelMode`'s first and load-bearing test — so with
// `slack.apps.<i>.defaultChannelMode: observe`, a DM (which has no override and
// therefore resolves to the app default) answered ordinary messages but refused
// `/ethos ask`, telling the user to go and do the thing they had just done.
//
// Every case below is under a SILENT mode. The point is that the mode does not
// reach the decision at all: there is no third party in a one-to-one
// conversation for it to be protecting.

/** A DM conversation id. Slack types conversations by id prefix: `D` is an
 *  `im`, `C` a channel, `G` a legacy private group / multi-person DM. */
const DM_CHANNEL = 'D_OWNER';

describe('a DM is not a room — the mode does not silence a one-to-one', () => {
  for (const mode of SILENT) {
    it(`/ethos ask runs in a DM under \`${mode}\``, async () => {
      const outcome = await runAsk(mode, 'ask what is the pour date', { id: DM_CHANNEL });

      expect(outcome.submitted).toEqual(['what is the pour date']);
      expect(outcome.responseType).toBe('in_channel');
    });

    it(`/ethos ask recognises a DM by channel_name alone under \`${mode}\``, async () => {
      // The second signal, for the case where the id prefix is not conclusive.
      // Slack sets `channel_name` to the literal `directmessage` on a slash
      // command invoked from an `im`.
      const outcome = await runAsk(mode, 'ask what is the pour date', {
        id: 'C_LOOKS_LIKE_A_CHANNEL',
        name: 'directmessage',
      });

      expect(outcome.submitted).toEqual(['what is the pour date']);
    });

    it(`link_shared unfurls in a DM under \`${mode}\``, async () => {
      const outcome = await deliverLinkShared(mode, DM_CHANNEL);

      expect(outcome.calls).toEqual(['chat.unfurl']);
    });
  }

  // The controls. Without these the three cases above would pass just as well
  // against a gate that had simply been deleted.
  for (const mode of SILENT) {
    it(`/ethos ask is still refused in a CHANNEL under \`${mode}\``, async () => {
      const outcome = await runAsk(mode, 'ask what is the pour date', { id: CHANNEL });

      expect(outcome.submitted).toEqual([]);
      expect(outcome.responseType).toBe('ephemeral');
    });

    it(`link_shared still unfurls nothing in a CHANNEL under \`${mode}\``, async () => {
      expect((await deliverLinkShared(mode, CHANNEL)).calls).toEqual([]);
    });
  }

  it('a multi-person DM is a ROOM, and stays silent', async () => {
    // `G`-prefixed: an mpim has other people in it, and the mode is protecting
    // them. `isSlackDm` matches only the `D` prefix for exactly this reason.
    const outcome = await runAsk('observe', 'ask what is the pour date', { id: 'G_MPIM' });

    expect(outcome.submitted).toEqual([]);
    expect(outcome.responseType).toBe('ephemeral');
  });
});
