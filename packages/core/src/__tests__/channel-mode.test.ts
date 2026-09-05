import { describe, expect, it } from 'vitest';
import { type ChannelModeInputs, evaluateChannelMode } from '../channel-mode';

// The full decision table. This function is the single decision point for four
// channel adapters, so the table is exhaustive rather than illustrative: every
// mode the four enums contain (plus an unrecognised one), crossed with every
// input that can change the answer. An error here is an error everywhere.

const MODES = ['mention_only', 'thread_follow', 'all', 'regex_match', 'observe', 'nonsense'];

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
  ...MODES.map((mode) => ({
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

  // --- unrecognised mode falls back to mention-only behaviour ---------------
  {
    mode: 'nonsense',
    isDm: false,
    isGroupMention: true,
    hasBotPosted: false,
    matches: false,
    reply: true,
    record: true,
  },
  {
    mode: 'nonsense',
    isDm: false,
    isGroupMention: false,
    hasBotPosted: true,
    matches: true,
    reply: false,
    record: false,
  },
];

describe('evaluateChannelMode — decision table', () => {
  for (const row of TABLE) {
    const label = `${row.mode} dm=${row.isDm} mention=${row.isGroupMention} botPosted=${row.hasBotPosted} match=${row.matches}`;
    it(`${label} -> reply=${row.reply} record=${row.record}`, () => {
      const decision = evaluateChannelMode({
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

describe('evaluateChannelMode — ordering invariants', () => {
  it('observe is checked before the mention test, so an @mention never breaks silence', () => {
    // The one behaviour the ordering exists for. If `isGroupMention` moved
    // above the observe branch this is the assertion that fails.
    const decision = evaluateChannelMode({
      isDm: false,
      isGroupMention: true,
      channelMode: 'observe',
    });
    expect(decision.shouldReply).toBe(false);
    expect(decision.shouldRecord).toBe(true);
  });

  it('a DM outranks observe', () => {
    expect(
      evaluateChannelMode({ isDm: true, isGroupMention: false, channelMode: 'observe' }),
    ).toEqual({ shouldReply: true, shouldRecord: true });
  });

  it('never records without replying outside observe mode', () => {
    for (const mode of MODES.filter((m) => m !== 'observe')) {
      for (const isGroupMention of [true, false]) {
        for (const hasBotPosted of [true, false]) {
          for (const matches of [true, false]) {
            const d = evaluateChannelMode({
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
    };
    expect(evaluateChannelMode(inputs)).toEqual({ shouldReply: false, shouldRecord: false });
  });

  it('treats a missing matchesPattern as no match in regex_match', () => {
    expect(
      evaluateChannelMode({ isDm: false, isGroupMention: false, channelMode: 'regex_match' }),
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
        isDm: false,
        isGroupMention: false,
        channelMode: mode,
        matchesPattern,
      });
    }
    expect(calls).toBe(0);
    evaluateChannelMode({
      isDm: false,
      isGroupMention: false,
      channelMode: 'regex_match',
      matchesPattern,
    });
    expect(calls).toBe(1);
  });

  it('returns an independent object each call', () => {
    const a = evaluateChannelMode({ isDm: true, isGroupMention: false, channelMode: 'all' });
    const b = evaluateChannelMode({ isDm: true, isGroupMention: false, channelMode: 'all' });
    a.shouldReply = false;
    expect(b.shouldReply).toBe(true);
  });
});
