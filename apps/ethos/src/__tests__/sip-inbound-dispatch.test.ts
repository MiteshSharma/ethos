import { InMemoryCallLog } from '@ethosagent/call-log';
import {
  createCallConcurrencyLimiter,
  createPerCallerRateLimiter,
  createVoiceDailyBudget,
  type InboundSipCall,
  type VoiceChannelAdapter,
} from '@ethosagent/platform-voice';
import type { AgentEvent, PersonalityConfig } from '@ethosagent/types';
import type { VoiceInboundGates } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import {
  createSipInboundHandler,
  type SipInboundDispatchDeps,
  type SipInboundVoiceStack,
} from '../sip-inbound-dispatch';

// The dispatcher is the only thing between a stranger's phone call and the
// agent's tools and memory. Every one of these tests is a property an operator
// pays for in provider minutes, in disclosure, or in a call they never hear
// about.

const OWNER_NUMBER = '+15550001111';
const STRANGER_NUMBER = '+447700900123';
const DID = '+15557654321';

const call: InboundSipCall = {
  fromNumber: STRANGER_NUMBER,
  toNumber: DID,
  roomName: 'call-15557654321-447700900123',
};
const knownCall: InboundSipCall = { ...call, fromNumber: OWNER_NUMBER };

const receptionistPersonality = { id: 'receptionist', name: 'Receptionist' } as PersonalityConfig;
const ownerPersonality = { id: 'assistant', name: 'Assistant' } as PersonalityConfig;

function gates(overrides: Partial<VoiceInboundGates> = {}): VoiceInboundGates {
  return {
    concurrency: createCallConcurrencyLimiter({ cap: 2 }),
    rateLimit: undefined,
    budget: createVoiceDailyBudget({}),
    allowlist: [OWNER_NUMBER],
    receptionist: 'receptionist',
    prewarm: 'allowlisted',
    owner: { platform: 'telegram', chatId: '42' },
    ...overrides,
  };
}

/** Enough of a `VoiceChannelAdapter` for the dispatch path: it starts, it can be
 *  asked for its transcript, and it hands its `onEnded` back so a test can hang
 *  up on demand. */
function fakeAdapter(transcript: string) {
  let onEnded: ((adapter: VoiceChannelAdapter) => void | Promise<void>) | undefined;
  const adapter = {
    started: 0,
    lastReplyText: () => transcript,
    start: async () => {
      adapter.started += 1;
    },
    setOnEnded: (fn?: (adapter: VoiceChannelAdapter) => void | Promise<void>) => {
      onEnded = fn;
    },
    hangUp: async () => {
      await onEnded?.(adapter as unknown as VoiceChannelAdapter);
    },
  };
  return adapter;
}

interface Harness {
  handle: ReturnType<typeof createSipInboundHandler>;
  callLog: InMemoryCallLog;
  notices: string[];
  inbound: VoiceInboundGates;
  turns: Array<{ text: string; personalityId?: string; sessionKey?: string; speaker?: string }>;
  adapterOptions: Array<{ personality?: PersonalityConfig }>;
}

function harness(
  opts: {
    inbound?: VoiceInboundGates;
    createSipAdapter?: SipInboundVoiceStack['createSipAdapter'];
    notifyOwner?: (text: string) => Promise<boolean>;
    bots?: SipInboundVoiceStack['bots'];
    /** Cost the fake loop reports on every turn, via a `usage` event. */
    turnCostUsd?: number;
  } = {},
): Harness {
  const callLog = new InMemoryCallLog();
  const notices: string[] = [];
  const inbound = opts.inbound ?? gates();
  const turns: Harness['turns'] = [];
  const adapterOptions: Harness['adapterOptions'] = [];

  const createSipAdapter =
    opts.createSipAdapter ??
    (async (adapterOpts) => {
      adapterOptions.push({ personality: adapterOpts.personality });
      const adapter = fakeAdapter('It was about a delivery.');
      adapter.setOnEnded(adapterOpts.onEnded);
      // Drive one turn so the runner's pinning (personality + far-end origin) is
      // observable rather than merely constructed.
      for await (const _event of adapterOpts.runner.run('hello?')) {
        // no events from the fake loop
      }
      return adapter as unknown as VoiceChannelAdapter;
    });

  const deps: SipInboundDispatchDeps = {
    voiceStack: {
      bots: opts.bots ?? [{ id: 'reception-line', match: DID }],
      inbound,
      createSipAdapter,
    },
    callLog,
    loop: {
      run: async function* (text, runOpts): AsyncGenerator<AgentEvent> {
        turns.push({
          text,
          personalityId: runOpts?.personalityId,
          sessionKey: runOpts?.sessionKey,
          speaker: runOpts?.voiceOrigin?.speaker,
        });
        if (opts.turnCostUsd !== undefined) {
          yield {
            type: 'usage',
            inputTokens: 100,
            outputTokens: 20,
            estimatedCostUsd: opts.turnCostUsd,
          };
        }
      },
    },
    botPersonalityId: () => 'assistant',
    personality: (id) => (id === 'receptionist' ? receptionistPersonality : ownerPersonality),
    notifyOwner:
      opts.notifyOwner ??
      (async (text) => {
        notices.push(text);
        return true;
      }),
    onError: () => {},
  };

  return {
    handle: createSipInboundHandler(deps),
    callLog,
    notices,
    inbound,
    turns,
    adapterOptions,
  };
}

describe('createSipInboundHandler — routing', () => {
  it('screens a call to an unbound number and still tells the owner', async () => {
    // A call nobody hears about is the failure this whole path exists to fix
    // (OpenClaw issue 77957), so "we could not route it" is still news.
    const h = harness({ bots: [{ id: 'other', match: '+19998887777' }] });
    const outcome = await h.handle(call, {});

    expect(outcome).toEqual({ dispatched: false, status: 'screened', reason: 'no_bot_match' });
    const row = await h.callLog.get(call.roomName);
    expect(row).toMatchObject({ status: 'screened', reason: 'no_bot_match', direction: 'inbound' });
    expect(row?.endedAt).toBeGreaterThan(0);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain(STRANGER_NUMBER);
    expect(h.inbound.concurrency.active()).toBe(0);
  });
});

describe('createSipInboundHandler — refusals', () => {
  it('refuses an unknown caller when no receptionist is configured', async () => {
    const h = harness({ inbound: gates({ receptionist: undefined }) });
    const outcome = await h.handle(call, {});

    expect(outcome).toEqual({ dispatched: false, status: 'screened', reason: 'not_allowlisted' });
    expect((await h.callLog.get(call.roomName))?.reason).toBe('not_allowlisted');
    expect(h.notices).toHaveLength(1);
    expect(h.inbound.concurrency.active()).toBe(0);
  });

  it('refuses over the concurrency cap and does not hold the slot it was denied', async () => {
    const concurrency = createCallConcurrencyLimiter({ cap: 1 });
    concurrency.tryAcquire('another-live-call');
    const h = harness({ inbound: gates({ concurrency }) });

    const outcome = await h.handle(call, {});
    expect(outcome).toEqual({ dispatched: false, status: 'refused', reason: 'over_concurrency' });
    expect((await h.callLog.get(call.roomName))?.status).toBe('refused');
    // The capacity refusal is the one the plan calls out for owner notification.
    expect(h.notices[0]).toContain('concurrent-call cap');
    expect(concurrency.active()).toBe(1); // still just the pre-existing call
  });

  it('refuses a hammering caller', async () => {
    const rateLimit = createPerCallerRateLimiter({ perHour: 1 });
    rateLimit.tryConsume(STRANGER_NUMBER);
    const h = harness({ inbound: gates({ rateLimit }) });

    const outcome = await h.handle(call, {});
    expect(outcome).toEqual({ dispatched: false, status: 'refused', reason: 'rate_limited' });
    expect((await h.callLog.get(call.roomName))?.reason).toBe('rate_limited');
    expect(h.notices).toHaveLength(1);
    expect(h.inbound.concurrency.active()).toBe(0);
  });

  it('refuses once the daily budget is spent', async () => {
    const budget = createVoiceDailyBudget({ limitUsd: 1 });
    budget.record(2);
    const h = harness({ inbound: gates({ budget }) });

    const outcome = await h.handle(call, {});
    expect(outcome).toEqual({ dispatched: false, status: 'refused', reason: 'over_budget' });
    expect((await h.callLog.get(call.roomName))?.reason).toBe('over_budget');
    expect(h.notices).toHaveLength(1);
    expect(h.inbound.concurrency.active()).toBe(0);
  });
});

describe('createSipInboundHandler — spend accounting', () => {
  // `voice.inbound.dailyBudgetUsd` was a cap nothing could ever reach: the gate
  // asked `budget.exceeded()` on every ring and no code path anywhere called
  // `budget.record()`, so `spent()` was permanently 0. These two tests are the
  // difference between a documented spend cap and a real one.

  it("records a call's turn spend against the budget the gate consults", async () => {
    const budget = createVoiceDailyBudget({ limitUsd: 10 });
    let hangUp: () => Promise<void> = async () => {};
    const h = harness({
      inbound: gates({ budget }),
      turnCostUsd: 0.25,
      createSipAdapter: async (opts) => {
        const adapter = fakeAdapter('Fine, thanks.');
        adapter.setOnEnded(opts.onEnded);
        hangUp = adapter.hangUp;
        for await (const _event of opts.runner.run('hello?')) {
          // drain — the metering rides the turn's event stream
        }
        return adapter as unknown as VoiceChannelAdapter;
      },
    });

    await h.handle(call, {});
    // Charged DURING the call, not at hang-up: an hour-long call must count
    // against today's budget while it is still running.
    expect(budget.spent()).toBeCloseTo(0.25, 10);
    expect(budget.remaining()).toBeCloseTo(9.75, 10);

    await hangUp();
    expect((await h.callLog.get(call.roomName))?.costUsd).toBeCloseTo(0.25, 10);
  });

  it('refuses the next call once the recorded spend reaches the cap', async () => {
    const budget = createVoiceDailyBudget({ limitUsd: 0.3 });
    const h = harness({
      inbound: gates({ budget, allowlist: [OWNER_NUMBER, STRANGER_NUMBER] }),
      turnCostUsd: 0.3,
    });

    const first = await h.handle(call, {});
    expect(first).toMatchObject({ dispatched: true, started: true });
    expect(budget.exceeded()).toBe(true);

    // A second ring, on a deployment that has now spent its day.
    const second = await h.handle({ ...call, roomName: 'call-second' }, {});
    expect(second).toEqual({ dispatched: false, status: 'refused', reason: 'over_budget' });
    expect((await h.callLog.get('call-second'))?.reason).toBe('over_budget');
  });
});

describe('createSipInboundHandler — accepted calls', () => {
  it('answers an unknown caller as the receptionist, restricted, with no pre-warm', async () => {
    const h = harness();
    const outcome = await h.handle(call, {});

    expect(outcome).toMatchObject({
      dispatched: true,
      restricted: true,
      prewarm: false,
      personalityId: 'receptionist',
      started: true,
    });
    expect(h.adapterOptions[0]?.personality).toBe(receptionistPersonality);
    const row = await h.callLog.get(call.roomName);
    expect(row).toMatchObject({ status: 'live', personalityId: 'receptionist' });
    expect(row?.laneKey).toContain(':sip:');
    expect(h.inbound.concurrency.active()).toBe(1);
  });

  it('answers an allowlisted caller as the bound personality, with pre-warm', async () => {
    const h = harness();
    const outcome = await h.handle(knownCall, {});

    expect(outcome).toMatchObject({
      dispatched: true,
      restricted: false,
      prewarm: true,
      personalityId: 'assistant',
    });
    expect(h.adapterOptions[0]?.personality).toBe(ownerPersonality);
  });

  it('pins every call turn to the far-end origin and the call lane', async () => {
    // `speaker: 'far_end'` is the whole security property: the spoken-confirmation
    // gate refuses a far-end request BEFORE consulting any recorded confirmation,
    // so a stranger's confident "yes" can never satisfy an owner-level approval
    // (eng-review D13).
    const h = harness();
    await h.handle(call, {});
    expect(h.turns[0]?.speaker).toBe('far_end');
    expect(h.turns[0]?.personalityId).toBe('receptionist');
    expect(h.turns[0]?.sessionKey).toContain(':sip:');
  });

  it('releases the slot when setup throws, and records the failure', async () => {
    const h = harness({
      createSipAdapter: async () => {
        throw new Error('livekit dial refused');
      },
    });

    const outcome = await h.handle(call, {});
    expect(outcome).toMatchObject({ dispatched: true, started: false });
    const row = await h.callLog.get(call.roomName);
    expect(row).toMatchObject({ status: 'failed', reason: 'livekit dial refused' });
    expect(row?.endedAt).toBeGreaterThan(0);
    expect(h.notices[0]).toContain('could not be answered');
    // The whole point: `cap` failed setups must not wedge the line permanently.
    expect(h.inbound.concurrency.active()).toBe(0);
  });

  it('fails honestly when no SIP media binding is wired', async () => {
    // `voice.livekit.*` unset (or no native media client supplied) leaves
    // `VoiceStack.createSipAdapter` absent. The call must land as a `failed` row
    // with a reason an operator can act on — never as a silent drop.
    const callLog = new InMemoryCallLog();
    const bare = createSipInboundHandler({
      voiceStack: { bots: [{ id: 'reception-line', match: DID }], inbound: gates() },
      callLog,
      // Never reached — adapter construction fails first.
      loop: {
        run: async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'done', text: '', turnCount: 0 };
        },
      },
      botPersonalityId: () => 'assistant',
      personality: () => ownerPersonality,
      notifyOwner: async () => true,
      onError: () => {},
    });

    const outcome = await bare(call, {});
    expect(outcome).toMatchObject({ dispatched: true, started: false });
    expect((await callLog.get(call.roomName))?.reason).toContain('no SIP media binding');
  });
});

describe('createSipInboundHandler — post-call summary', () => {
  it('writes the transcript and summary onto the row and notifies the owner', async () => {
    let hangUp: () => Promise<void> = async () => {};
    const h = harness({
      createSipAdapter: async (opts) => {
        const adapter = fakeAdapter('It was about a delivery.');
        adapter.setOnEnded(opts.onEnded);
        hangUp = adapter.hangUp;
        return adapter as unknown as VoiceChannelAdapter;
      },
    });

    await h.handle(call, {});
    expect(h.inbound.concurrency.active()).toBe(1);

    await hangUp();

    const row = await h.callLog.get(call.roomName);
    expect(row).toMatchObject({ status: 'completed', transcript: 'It was about a delivery.' });
    expect(row?.summary).toContain('It was about a delivery.');
    expect(row?.endedAt).toBeGreaterThan(0);
    // Through `notifyTracked` — the delivery ledger writes the obligation before
    // the platform call, so a summary the network eats comes back on boot.
    expect(h.notices.at(-1)).toContain('It was about a delivery.');
    expect(h.inbound.concurrency.active()).toBe(0);
  });

  it('survives an unconfirmed delivery without throwing out of the hang-up path', async () => {
    let hangUp: () => Promise<void> = async () => {};
    const h = harness({
      notifyOwner: async () => false,
      createSipAdapter: async (opts) => {
        const adapter = fakeAdapter('Nothing important.');
        adapter.setOnEnded(opts.onEnded);
        hangUp = adapter.hangUp;
        return adapter as unknown as VoiceChannelAdapter;
      },
    });

    await h.handle(call, {});
    await expect(hangUp()).resolves.toBeUndefined();

    const row = await h.callLog.get(call.roomName);
    expect(row).toMatchObject({ status: 'completed', transcript: 'Nothing important.' });
    expect(row?.summary).toContain('Nothing important.');
    expect(h.inbound.concurrency.active()).toBe(0);
  });
});
