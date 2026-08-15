import { deriveBotKey, voiceLaneKey } from '@ethosagent/core';
import type { AgentTurnRunner } from '@ethosagent/voice-session';
import { VoiceSession } from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import { type VoiceBotIdentity, VoiceChannelAdapter } from '../adapter';
import {
  createInboundDispatcher,
  matchesVoicePattern,
  resolveVoiceBot,
} from '../sip/inbound-dispatch';
import { createPostCallSummary } from '../sip/post-call-summary';
import type { InboundSipCall } from '../sip/trunk-client';
import {
  FakeVad,
  FakeVoiceTransport,
  makeClock,
  scriptedRunner,
  streamingStt,
  streamingTts,
  tick,
} from './fakes';

function makeSession(runner: AgentTurnRunner, clock = makeClock()): VoiceSession {
  return new VoiceSession({
    runner,
    stt: streamingStt('caller said hi'),
    tts: streamingTts(),
    vad: new FakeVad(),
    now: clock.now,
  });
}

describe('matchesVoicePattern', () => {
  it('matches exact E.164 numbers and wildcard patterns', () => {
    expect(matchesVoicePattern('+15551234567', '+15551234567')).toBe(true);
    expect(matchesVoicePattern('+15551234567', '+1555*')).toBe(true);
    expect(matchesVoicePattern('+16665550000', '+1555*')).toBe(false);
    expect(matchesVoicePattern('room-support-42', 'room-support-*')).toBe(true);
    // `*` is the only metachar — a literal `+` must not act as a regex quantifier.
    expect(matchesVoicePattern('15551234567', '+15551234567')).toBe(false);
  });
});

describe('resolveVoiceBot', () => {
  const bots: VoiceBotIdentity[] = [
    { id: 'reception', match: '+1555*' },
    { id: 'sales', match: '+1666*' },
  ];

  it('picks the first bot whose pattern matches (config order)', () => {
    expect(resolveVoiceBot('+15551234567', bots)?.id).toBe('reception');
    expect(resolveVoiceBot('+16669990000', bots)?.id).toBe('sales');
  });

  it('returns null when no bot answers the dialed number', () => {
    expect(resolveVoiceBot('+17770000000', bots)).toBeNull();
  });
});

describe('createInboundDispatcher', () => {
  // Dialed DID -> personality binding (the `voice.bots[]` mapping), resolved by
  // the injected builder exactly as the app layer would.
  const bots: VoiceBotIdentity[] = [
    { id: 'reception', match: '+1555*' },
    { id: 'sales', match: '+1666*' },
  ];
  const personalityForBot: Record<string, string> = {
    reception: 'greeter',
    sales: 'closer',
  };

  function buildAdapter(bot: VoiceBotIdentity, call: InboundSipCall): VoiceChannelAdapter {
    // callerId = the caller's E.164 number, so the lane key is per-caller.
    const transport = new FakeVoiceTransport(call.fromNumber);
    return new VoiceChannelAdapter({
      transport,
      session: makeSession(scriptedRunner([])),
      bot,
    });
  }

  it('resolves an inbound number -> personality -> adapter with callerId = caller number', () => {
    const built: string[] = [];
    const dispatch = createInboundDispatcher({
      bots,
      buildAdapter: (bot, call) => {
        built.push(personalityForBot[bot.id ?? '']);
        return buildAdapter(bot, call);
      },
    });

    const adapter = dispatch({
      fromNumber: '+15551234567',
      toNumber: '+15550000001',
      roomName: 'sip-room-1',
    });

    expect(adapter).not.toBeNull();
    // The dialed DID '+1555…' selected the reception bot -> greeter personality.
    expect(built).toEqual(['greeter']);
    // callerId is the CALLER's number (per-caller lane), not the dialed DID.
    expect(adapter?.callerId).toBe('+15551234567');
    expect(adapter?.botKey).toBe('reception');
    expect(adapter?.laneKey).toBe(
      voiceLaneKey('reception', { kind: 'livekit', id: '+15551234567' }),
    );
  });

  it('returns null for a dialed number bound to no bot', () => {
    const dispatch = createInboundDispatcher({ bots, buildAdapter });
    expect(dispatch({ fromNumber: '+1', toNumber: '+19998887777', roomName: 'r' })).toBeNull();
  });

  it('reuses the same lane for a second call from the same caller (cross-call memory)', () => {
    const dispatch = createInboundDispatcher({ bots, buildAdapter });
    const call: InboundSipCall = {
      fromNumber: '+15551234567',
      toNumber: '+15550000001',
      roomName: 'sip-room-a',
    };
    const first = dispatch(call);
    // Second call, same caller, different room — same lane key => same session
    // history via the SessionStore path.
    const second = dispatch({ ...call, roomName: 'sip-room-b' });

    expect(first?.laneKey).toBe(
      voiceLaneKey('reception', { kind: 'livekit', id: call.fromNumber }),
    );
    expect(second?.laneKey).toBe(first?.laneKey);
  });

  it('uses a match-derived botKey when a bot has no explicit id', () => {
    const dispatch = createInboundDispatcher({
      bots: [{ match: '+1555*' }],
      buildAdapter,
    });
    const adapter = dispatch({
      fromNumber: '+15559998888',
      toNumber: '+15551112222',
      roomName: 'r',
    });
    expect(adapter?.botKey).toBe(deriveBotKey('+1555*'));
    expect(adapter?.laneKey).toBe(
      voiceLaneKey(deriveBotKey('+1555*'), { kind: 'livekit', id: '+15559998888' }),
    );
  });
});

describe('createPostCallSummary', () => {
  // Faithful stand-in for the gateway's single dedup gate (MessageDedupCache,
  // keyed by `${sessionId}:${content}`). Summaries flow through here.
  function dedupSink() {
    const seen = new Set<string>();
    const delivered: string[] = [];
    return {
      delivered,
      sink: (a: { sessionId: string; content: string }): void => {
        const key = `${a.sessionId}:${a.content}`;
        if (seen.has(key)) return;
        seen.add(key);
        delivered.push(a.content);
      },
    };
  }

  it('posts a default summary through the deduped send gate', async () => {
    const { delivered, sink } = dedupSink();
    const transport = new FakeVoiceTransport('+15551234567');
    const session = makeSession(scriptedRunner([{ type: 'text_delta', text: 'Hi, all set.' }]));
    const adapter = new VoiceChannelAdapter({
      transport,
      session,
      bot: { id: 'reception', match: '+1555*' },
      sendArtifact: sink,
    });

    const onCallEnd = createPostCallSummary();
    await onCallEnd(adapter);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('+15551234567');
  });

  it('routes a custom summary through dedup and drops a duplicate', async () => {
    const { delivered, sink } = dedupSink();
    const adapter = new VoiceChannelAdapter({
      transport: new FakeVoiceTransport('+1777'),
      session: makeSession(scriptedRunner([])),
      bot: { match: '+1*' },
      sendArtifact: sink,
    });

    const onCallEnd = createPostCallSummary({ summarize: () => 'Fixed summary line.' });
    await onCallEnd(adapter);
    await onCallEnd(adapter); // identical content + lane => deduped

    expect(delivered).toEqual(['Fixed summary line.']);
  });

  it('is a no-op when the adapter has no paired text channel (no sink)', async () => {
    const adapter = new VoiceChannelAdapter({
      transport: new FakeVoiceTransport('+1777'),
      session: makeSession(scriptedRunner([])),
      bot: { match: '+1*' },
    });
    const onCallEnd = createPostCallSummary();
    // Resolves without throwing even though nothing is delivered.
    await expect(onCallEnd(adapter)).resolves.toBeUndefined();
  });

  it('routes through `deliver` instead of the artifact sink when supplied', async () => {
    const { delivered, sink } = dedupSink();
    const ledger: Array<{ laneKey: string; callerId: string; text: string }> = [];
    const adapter = new VoiceChannelAdapter({
      transport: new FakeVoiceTransport('+15551234567'),
      session: makeSession(scriptedRunner([{ type: 'text_delta', text: 'All set.' }])),
      bot: { id: 'reception', match: '+1555*' },
      sendArtifact: sink,
    });

    const onCallEnd = createPostCallSummary({
      deliver: async (summary) => {
        ledger.push(summary);
      },
    });
    await onCallEnd(adapter);

    // The ledger path took it; the direct artifact sink was NOT used.
    expect(delivered).toHaveLength(0);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.laneKey).toBe(adapter.laneKey);
    expect(ledger[0]?.callerId).toBe('+15551234567');
    expect(ledger[0]?.text).toContain('+15551234567');
  });

  // A failed summary must not take down the hang-up path — the handler runs
  // from the adapter's call-end trigger, often with no caller to catch.
  it('reports summarizer and delivery failures through onError instead of throwing', async () => {
    const adapter = new VoiceChannelAdapter({
      transport: new FakeVoiceTransport('+1777'),
      session: makeSession(scriptedRunner([])),
      bot: { match: '+1*' },
    });

    const summarizerErrors: unknown[] = [];
    await expect(
      createPostCallSummary({
        summarize: () => {
          throw new Error('llm unavailable');
        },
        onError: (err) => summarizerErrors.push(err),
      })(adapter),
    ).resolves.toBeUndefined();
    expect(String(summarizerErrors[0])).toContain('llm unavailable');

    const deliveryErrors: unknown[] = [];
    await expect(
      createPostCallSummary({
        deliver: () => Promise.reject(new Error('ledger write failed')),
        onError: (err) => deliveryErrors.push(err),
      })(adapter),
    ).resolves.toBeUndefined();
    expect(String(deliveryErrors[0])).toContain('ledger write failed');
  });

  it('swallows a failure when no onError sink is wired', async () => {
    const adapter = new VoiceChannelAdapter({
      transport: new FakeVoiceTransport('+1777'),
      session: makeSession(scriptedRunner([])),
      bot: { match: '+1*' },
    });
    await expect(
      createPostCallSummary({
        deliver: () => Promise.reject(new Error('boom')),
      })(adapter),
    ).resolves.toBeUndefined();
  });
});

// The call-end trigger the summary handler has never had: wiring it as the
// adapter's `onEnded` means a caller who simply hangs up still produces one.
describe('createPostCallSummary wired as the adapter call-end trigger', () => {
  it('produces exactly one summary on a remote hang-up', async () => {
    const delivered: string[] = [];
    const transport = new FakeVoiceTransport('+15551234567');
    const adapter = new VoiceChannelAdapter({
      transport,
      session: makeSession(scriptedRunner([])),
      bot: { id: 'reception', match: '+1555*' },
      laneKind: 'sip',
      onEnded: createPostCallSummary({
        deliver: async (summary) => {
          delivered.push(summary.text);
        },
      }),
    });

    await adapter.start();
    transport.close();
    await tick();
    await adapter.stop();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('+15551234567');
  });
});
