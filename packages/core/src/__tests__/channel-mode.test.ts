import { describe, expect, it } from 'vitest';
import { type ChannelModeInputs, evaluateChannelMode } from '../channel-mode';

// The full decision table. This function is the single decision point for four
// channel adapters, so the table is exhaustive rather than illustrative: every
// mode the four enums contain (plus an unrecognised one), crossed with every
// input that can change the answer. An error here is an error everywhere.

const MODES = ['mention_only', 'thread_follow', 'all', 'regex_match', 'observe'];

// The table below is the DECISION table: what each mode means once an adapter
// has said it offers that mode. So it declares support for all five and varies
// only the inputs. Which modes an adapter offers is a separate question, and
// it has its own suite ('supportedModes is per-adapter' at the bottom of this
// file) — that is where the regex_match-on-Slack case lives.
const SUPPORTED = MODES;

// Values `evaluateChannelMode` does not know. Not one shape of nonsense but
// every shape that reaches a mode string in practice: a mode from a newer
// build read by a downgraded one, a hand-edited typo, a case or whitespace
// slip, and the empty string a half-written override file leaves behind.
const UNKNOWN_MODES = [
  'nonsense',
  'silent_digest_only',
  'Observe',
  'mention_only ',
  '',
  'all,observe',
];

const ALL_MODES = [...MODES, ...UNKNOWN_MODES];

type Row = {
  mode: string;
  isDm: boolean;
  isGroupMention: boolean;
  hasBotPosted: boolean;
  matches: boolean;
  reply: boolean;
  record: boolean;
};

/** mode | isDm | mention | botPosted | patternMatch | shouldReply | shouldRecord */
const TABLE: Row[] = [
  // --- DMs: always a conversation, whatever the mode says -------------------
  ...ALL_MODES.map((mode) => ({
    mode,
    isDm: true,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  })),

  // --- observe: never replies, not even to an explicit @mention -------------
  {
    mode: 'observe',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: false,
    record: true,
  },
  {
    mode: 'observe',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: false,
    record: true,
  },
  {
    mode: 'observe',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: true,
    matches: true,
    reply: false,
    record: true,
  },
  {
    mode: 'observe',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: true,
    matches: true,
    reply: false,
    record: true,
  },

  // --- all: replies to everything in the room -------------------------------
  {
    mode: 'all',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },
  {
    mode: 'all',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },

  // --- mention_only: the baseline -------------------------------------------
  {
    mode: 'mention_only',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },
  {
    mode: 'mention_only',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: false,
    record: false,
  },
  // hasBotPosted / matchesPattern are inert outside their own modes
  {
    mode: 'mention_only',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: true,
    matches: true,
    reply: false,
    record: false,
  },

  // --- thread_follow ---------------------------------------------------------
  {
    mode: 'thread_follow',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: true,
    matches: false,
    reply: true,
    record: true,
  },
  {
    mode: 'thread_follow',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: false,
    record: false,
  },
  {
    mode: 'thread_follow',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },
  // a pattern match does not rescue thread_follow
  {
    mode: 'thread_follow',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: true,
    reply: false,
    record: false,
  },

  // --- regex_match (Telegram only) ------------------------------------------
  {
    mode: 'regex_match',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: true,
    reply: true,
    record: true,
  },
  {
    mode: 'regex_match',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: false,
    matches: false,
    reply: false,
    record: false,
  },
  {
    mode: 'regex_match',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },
  // hasBotPosted does not rescue regex_match
  {
    mode: 'regex_match',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: true,
    matches: false,
    reply: false,
    record: false,
  },

  // --- unrecognised mode: fail closed, mention or no mention ----------------
  // This USED to fall through to the mention-only baseline and answer. A mode
  // string this build cannot read is a mode it cannot be safe about, and the
  // modes that get added are the silent ones, so it is dropped instead.
  ...UNKNOWN_MODES.flatMap((mode) => [
    {
      mode,
      isDm: false,
      isGroupMention: true,
      hasBotPosted: false,
      matches: false,
      reply: false,
      record: false,
    },
    {
      mode,
      isDm: false,
      isGroupMention: false,
      hasBotPosted: true,
      matches: true,
      reply: false,
      record: false,
    },
    {
      mode,
      isDm: false,
      isGroupMention: true,
      hasBotPosted: true,
      matches: true,
      reply: false,
      record: false,
    },
  ]),
];

describe('evaluateChannelMode — decision table', () => {
  for (const row of TABLE) {
    const label = `${row.mode} dm=${row.isDm} mention=${row.isGroupMention} botPosted=${row.hasBotPosted} match=${row.matches}`;
    it(`${label} -> reply=${row.reply} record=${row.record}`, () => {
      const decision = evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: row.isDm,
        isGroupMention: row.isGroupMention,
        channelMode: row.mode,
        hasBotPosted: row.hasBotPosted,
        matchesPattern: () => row.matches,
      });
      expect(decision).toEqual({ shouldReply: row.reply, shouldRecord: row.record });
    });
  }
});

describe('evaluateChannelMode — unrecognised modes fail closed', () => {
  for (const mode of UNKNOWN_MODES) {
    it(`${JSON.stringify(mode)} is never eligible to reply, whatever the inputs`, () => {
      for (const isGroupMention of [true, false]) {
        for (const hasBotPosted of [true, false]) {
          for (const matches of [true, false]) {
            expect(
              evaluateChannelMode({
                supportedModes: SUPPORTED,
                isDm: false,
                isGroupMention,
                channelMode: mode,
                hasBotPosted,
                matchesPattern: () => matches,
              }),
            ).toEqual({ shouldReply: false, shouldRecord: false });
          }
        }
      }
    });
  }

  it('an @mention does not rescue an unrecognised mode', () => {
    // The exact case that used to answer: `isGroupMention` was the fallback
    // branch for anything the evaluator did not recognise.
    expect(
      evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: false,
        isGroupMention: true,
        channelMode: 'silent_digest_only',
      }),
    ).toEqual({ shouldReply: false, shouldRecord: false });
  });

  it('does not consult matchesPattern for an unrecognised mode', () => {
    let calls = 0;
    evaluateChannelMode({
      supportedModes: SUPPORTED,
      isDm: false,
      isGroupMention: false,
      channelMode: 'regex_match_v2',
      matchesPattern: () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(0);
  });

  it('still answers a DM under an unrecognised mode', () => {
    // A DM is not a room. Dropping it would deafen the bot to its own owner
    // and leave no channel to report the bad override through.
    expect(
      evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: true,
        isGroupMention: false,
        channelMode: 'nonsense',
      }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });
});

describe('evaluateChannelMode — ordering invariants', () => {
  it('observe is checked before the mention test, so an @mention never breaks silence', () => {
    // The one behaviour the ordering exists for. If `isGroupMention` moved
    // above the observe branch this is the assertion that fails.
    const decision = evaluateChannelMode({
      supportedModes: SUPPORTED,
      isDm: false,
      isGroupMention: true,
      channelMode: 'observe',
    });
    expect(decision.shouldReply).toBe(false);
    expect(decision.shouldRecord).toBe(true);
  });

  it('a DM outranks observe', () => {
    expect(
      evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: true,
        isGroupMention: false,
        channelMode: 'observe',
      }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });

  it('never records without replying outside observe mode', () => {
    for (const mode of ALL_MODES.filter((m) => m !== 'observe')) {
      for (const isGroupMention of [true, false]) {
        for (const hasBotPosted of [true, false]) {
          for (const matches of [true, false]) {
            const d = evaluateChannelMode({
              supportedModes: SUPPORTED,
              isDm: false,
              isGroupMention,
              channelMode: mode,
              hasBotPosted,
              matchesPattern: () => matches,
            });
            expect(d.shouldRecord).toBe(d.shouldReply);
          }
        }
      }
    }
  });
});

describe('evaluateChannelMode — optional inputs', () => {
  it('treats a missing hasBotPosted as false in thread_follow', () => {
    const inputs: ChannelModeInputs = {
      isDm: false,
      isGroupMention: false,
      channelMode: 'thread_follow',
      supportedModes: SUPPORTED,
    };
    expect(evaluateChannelMode(inputs)).toEqual({ shouldReply: false, shouldRecord: false });
  });

  it('treats a missing matchesPattern as no match in regex_match', () => {
    expect(
      evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: false,
        isGroupMention: false,
        channelMode: 'regex_match',
      }),
    ).toEqual({ shouldReply: false, shouldRecord: false });
  });

  it('only consults matchesPattern in regex_match mode', () => {
    let calls = 0;
    const matchesPattern = () => {
      calls += 1;
      return true;
    };
    for (const mode of ['mention_only', 'thread_follow', 'all', 'observe']) {
      evaluateChannelMode({
        supportedModes: SUPPORTED,
        isDm: false,
        isGroupMention: false,
        channelMode: mode,
        matchesPattern,
      });
    }
    expect(calls).toBe(0);
    evaluateChannelMode({
      supportedModes: SUPPORTED,
      isDm: false,
      isGroupMention: false,
      channelMode: 'regex_match',
      matchesPattern,
    });
    expect(calls).toBe(1);
  });

  it('returns an independent object each call', () => {
    const a = evaluateChannelMode({
      supportedModes: SUPPORTED,
      isDm: true,
      isGroupMention: false,
      channelMode: 'all',
    });
    const b = evaluateChannelMode({
      supportedModes: SUPPORTED,
      isDm: true,
      isGroupMention: false,
      channelMode: 'all',
    });
    a.shouldReply = false;
    expect(b.shouldReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// supportedModes is PER-ADAPTER, not the union of every adapter's enum
// ---------------------------------------------------------------------------

// This is the half of the contract `ChannelOverrideStore` (../channel-overrides)
// promises and could not previously keep. Its `parseRecord` deliberately KEEPS
// a record whose mode the adapter's enum rejects — carrying the raw string
// verbatim — so that `override?.mode ?? default` hands an unreadable value to
// this function rather than laundering it into the answering `mention_only`
// default. That only works if "unreadable" means unreadable TO THIS ADAPTER.
//
// It used to mean "outside a hard-coded union of all four adapters' enums",
// under which a `regex_match` line in a Slack override file — hand-edited, or
// copied from a Telegram one; no Slack surface can write it — was recognised
// by a build that has no `regex_match`. Slack supplies no `matchesPattern`, so
// its message path dropped every message UNRECORDED while `triageMention`, the
// join greeting, the `link_shared` unfurl and `/ethos ask` all fell through to
// the answering `isGroupMention` branch. A channel that records nothing and
// speaks on four paths.
//
// The enums, as of this commit (each adapter's `CHANNEL_MODES` in its
// `src/config.ts`, which is also what builds its `ChannelModeSchema`):
const ADAPTER_ENUMS = {
  slack: ['mention_only', 'thread_follow', 'all', 'observe'],
  discord: ['mention_only', 'thread_follow', 'all', 'observe'],
  telegram: ['mention_only', 'thread_follow', 'all', 'regex_match', 'observe'],
  whatsapp: ['all', 'mention_only', 'observe'],
} as const;

describe('evaluateChannelMode — supportedModes is per-adapter', () => {
  it('refuses regex_match on an adapter whose enum has no regex_match', () => {
    // The exact laundering case. `isGroupMention: true` is the branch that used
    // to answer, and `canSpeakInChannel` on both Slack and Discord asks this
    // question with exactly these inputs.
    for (const platform of ['slack', 'discord', 'whatsapp'] as const) {
      expect(
        evaluateChannelMode({
          isDm: false,
          isGroupMention: true,
          channelMode: 'regex_match',
          supportedModes: ADAPTER_ENUMS[platform],
        }),
        platform,
      ).toEqual({ shouldReply: false, shouldRecord: false });
    }
  });

  it('still honours regex_match on the adapter that offers it', () => {
    // The control: without it the case above would pass against an evaluator
    // that had simply deleted `regex_match`.
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'regex_match',
        supportedModes: ADAPTER_ENUMS.telegram,
        matchesPattern: () => true,
      }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });

  it('refuses thread_follow on an adapter with no threads', () => {
    // WhatsApp's enum is the smallest of the four; `thread_follow` in its
    // override file is a mode it has no branch for.
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: true,
        channelMode: 'thread_follow',
        supportedModes: ADAPTER_ENUMS.whatsapp,
      }),
    ).toEqual({ shouldReply: false, shouldRecord: false });
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: true,
        channelMode: 'thread_follow',
        supportedModes: ADAPTER_ENUMS.slack,
      }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });

  it('never consults matchesPattern for a mode the adapter does not support', () => {
    let calls = 0;
    evaluateChannelMode({
      isDm: false,
      isGroupMention: true,
      channelMode: 'regex_match',
      supportedModes: ADAPTER_ENUMS.slack,
      matchesPattern: () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(0);
  });

  it('answers a DM whatever the adapter supports — a DM is not a room', () => {
    // `isDm` is tested before `supportedModes` on purpose: an unreadable
    // override must not deafen the bot to its own owner, leaving no channel to
    // report the bad override through.
    expect(
      evaluateChannelMode({
        isDm: true,
        isGroupMention: false,
        channelMode: 'regex_match',
        supportedModes: ADAPTER_ENUMS.slack,
      }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });

  it('an empty supportedModes answers nothing in a room', () => {
    for (const mode of ALL_MODES) {
      expect(
        evaluateChannelMode({
          isDm: false,
          isGroupMention: true,
          channelMode: mode,
          supportedModes: [],
        }),
        mode,
      ).toEqual({ shouldReply: false, shouldRecord: false });
    }
  });
});
