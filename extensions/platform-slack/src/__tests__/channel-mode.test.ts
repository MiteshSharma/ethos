// Slack's reply/record decision is now `evaluateChannelMode` from
// `@ethosagent/core` (plan/phases/ambient-group-monitoring.md R6). This suite
// is kept as the regression guard on Slack's *use* of it: every case the
// deleted local `shouldRespond` asserted, driven with Slack's own inputs.
//
// The assertions changed shape, not strength. `shouldRespond` returned one
// boolean; the shared evaluator returns `{ shouldReply, shouldRecord }`,
// because a boolean cannot express `observe` (do not reply, DO record). Each
// case below still pins the same reply/ignore fact — `toEqual` on the whole
// decision fails for a wrong answer on EITHER field, where `toBe(false)` could
// not distinguish "ignored" from "recorded silently" at all.

import { evaluateChannelMode } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';

const ENGAGE = { shouldReply: true, shouldRecord: true };
const IGNORE = { shouldReply: false, shouldRecord: false };
const OBSERVE = { shouldReply: false, shouldRecord: true };

describe('evaluateChannelMode (shared core decision, Slack binding)', () => {
  it('always responds in DMs', () => {
    expect(
      evaluateChannelMode({
        isDm: true,
        isGroupMention: false,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toEqual(ENGAGE);
  });

  it('mention_only ignores plain channel posts', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toEqual(IGNORE);
  });

  it('mention_only responds to @mentions', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: true,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toEqual(ENGAGE);
  });

  it('thread_follow without prior bot post acts like mention_only', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'thread_follow',
        hasBotPosted: false,
      }),
    ).toEqual(IGNORE);
  });

  it('thread_follow with prior bot post responds', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'thread_follow',
        hasBotPosted: true,
      }),
    ).toEqual(ENGAGE);
  });

  it('all responds to every channel post', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'all',
        hasBotPosted: false,
      }),
    ).toEqual(ENGAGE);
  });

  it('observe records a plain channel post without replying', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: false,
        channelMode: 'observe',
        hasBotPosted: false,
      }),
    ).toEqual(OBSERVE);
  });

  it('observe records an @mention without replying', () => {
    expect(
      evaluateChannelMode({
        isDm: false,
        isGroupMention: true,
        channelMode: 'observe',
        hasBotPosted: false,
      }),
    ).toEqual(OBSERVE);
  });
});
