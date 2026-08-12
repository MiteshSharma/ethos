import type { RealtimeToolHost } from '@ethosagent/tools-voice';
import type { VoiceServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  REALTIME_ACCRUAL_INTERVAL_MS,
  REALTIME_BUDGET_SIGN_OFF,
  REALTIME_MAX_DEAD_AIR_MS,
  RealtimeControlLane,
  type RealtimeControlLaneDeps,
  type RealtimeControlLaneEvent,
  type RealtimeHaltEvent,
  type RealtimeSessionBinding,
  type RealtimeUsageEvent,
} from '../realtime-control-lane';

// A hand-driven clock. Nothing here uses real timers: the acceptance criterion
// is about a bound, and a bound verified by sleeping is a bound verified once,
// slowly, on one machine.
class FakeClock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  /** Advance to `target`, firing every timer due on the way, in due order. */
  advanceTo(target: number): void {
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      if (!timer) break;
      this.t = timer.at;
      timer.fn();
    }
    this.t = target;
  }
}

interface Harness {
  lane: RealtimeControlLane;
  frames: VoiceServerFrame[];
  clock: FakeClock;
  transcripts: Array<{ role: string; text: string }>;
  /** Resolve the in-flight consult with `output`. */
  finish(callId: string, output?: string): void;
  order: string[];
  /** Every usage event the lane reported, in order. */
  usage: RealtimeUsageEvent[];
  halts: RealtimeHaltEvent[];
  laneEvents: RealtimeControlLaneEvent[];
  /**
   * What the lane observes as this session's spend: everything it accrued plus
   * anything a consult added. Stands in for `AgentLoop.sessionCosts`.
   */
  spendUsd(): number;
  /** A consulted turn spending money on the same lane key. */
  addConsultSpend(usd: number): void;
  /** `{frame, open}` per send, so "before the close" is observable, not assumed. */
  timeline: Array<{ t: string; open: boolean }>;
}

function harness(
  opts: {
    laneKey?: string;
    handled?: string[];
    costPerMinuteUsd?: number;
    sessionBudgetUsd?: number;
  } = {},
): Harness {
  const clock = new FakeClock();
  const frames: VoiceServerFrame[] = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  const order: string[] = [];
  const usage: RealtimeUsageEvent[] = [];
  const halts: RealtimeHaltEvent[] = [];
  const laneEvents: RealtimeControlLaneEvent[] = [];
  const timeline: Array<{ t: string; open: boolean }> = [];
  let consultSpend = 0;
  const pendingCalls = new Map<string, (output: string) => void>();

  const host: RealtimeToolHost = {
    definitions: (opts.handled ?? ['agent_consult']).map((name) => ({
      name,
      description: name,
      parameters: {},
    })),
    handled: opts.handled ?? ['agent_consult'],
    dispatch(call) {
      order.push(`start:${call.callId}`);
      return new Promise((resolve) => {
        pendingCalls.set(call.callId, (output) => {
          order.push(`end:${call.callId}`);
          resolve({ ok: true, output });
        });
      });
    },
  };

  const binding: RealtimeSessionBinding = {
    laneKey: opts.laneKey ?? 'voice:web:browser:chat-9',
    storeSessionId: 'row-1',
    host,
    workingDir: '/tmp',
    ...(opts.costPerMinuteUsd !== undefined ? { costPerMinuteUsd: opts.costPerMinuteUsd } : {}),
    ...(opts.sessionBudgetUsd !== undefined ? { sessionBudgetUsd: opts.sessionBudgetUsd } : {}),
  };

  let accruedUsd = 0;
  const spendUsd = (): number => accruedUsd + consultSpend;

  const deps: RealtimeControlLaneDeps = {
    open: async () => binding,
    persistTranscript: async (_binding, role, text) => {
      transcripts.push({ role, text });
    },
    onUsage: (_binding, event) => {
      usage.push(event);
      // What `AgentLoop.addSessionCost` does in production.
      accruedUsd += event.estimatedCostUsd;
    },
    onHalt: (_binding, halt) => halts.push(halt),
    sessionSpendUsd: () => spendUsd(),
    onEvent: (event) => laneEvents.push(event),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };

  const lane = new RealtimeControlLane({
    deps,
    send: (frame) => {
      frames.push(frame);
      timeline.push({ t: frame.t, open: lane.isOpen });
    },
  });
  return {
    lane,
    frames,
    clock,
    transcripts,
    order,
    usage,
    halts,
    laneEvents,
    timeline,
    spendUsd,
    addConsultSpend: (usd) => {
      consultSpend += usd;
    },
    finish: (callId, output = 'the answer') => pendingCalls.get(callId)?.(output),
  };
}

/** Let queued microtasks (the lane's FIFO) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('realtime control lane — opening', () => {
  it('reports the lane key and the tools it will service', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();

    expect(h.frames).toContainEqual({
      t: 'realtime_ready',
      laneKey: 'voice:web:browser:chat-9',
      tools: ['agent_consult'],
    });
    expect(h.lane.laneKey).toBe('voice:web:browser:chat-9');
  });

  it('answers a tool call that arrives before the call is open', async () => {
    // An unanswered tool call leaves a realtime session waiting forever, which
    // sounds exactly like the agent ignoring the person.
    const h = harness();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();

    expect(h.frames.filter((f) => f.t === 'realtime_tool_result')).toEqual([
      {
        t: 'realtime_tool_result',
        callId: 'c1',
        ok: false,
        output: 'This call has not finished connecting to the assistant.',
      },
    ]);
    expect(h.order).toEqual([]);
  });
});

describe('realtime control lane — no dead air', () => {
  it('never leaves a gap over 2 s during a slow consult', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    const spokenAt: number[] = [];
    const record = (): void => {
      // Every frame that produces speech counts: the ack, each filler, and the
      // result the model reads out.
      spokenAt.push(h.clock.now());
    };
    const before = h.frames.length;

    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();

    // A twelve-second consult — a real one, with tools and a slow model.
    const CONSULT_MS = 12_000;
    let seen = before;
    for (let t = 0; t <= CONSULT_MS; t += 100) {
      h.clock.advanceTo(t);
      for (; seen < h.frames.length; seen++) {
        const frame = h.frames[seen];
        if (frame?.t === 'realtime_speak') record();
      }
    }
    h.finish('c1');
    await settle();
    for (; seen < h.frames.length; seen++) {
      const frame = h.frames[seen];
      if (frame?.t === 'realtime_tool_result') record();
    }

    expect(spokenAt.length).toBeGreaterThan(5);
    // Silence before the FIRST line counts too — the ack must be immediate.
    expect(spokenAt[0]).toBe(0);
    for (let i = 1; i < spokenAt.length; i++) {
      const gap = (spokenAt[i] ?? 0) - (spokenAt[i - 1] ?? 0);
      expect(gap, `gap of ${gap}ms after line ${i - 1}`).toBeLessThanOrEqual(
        REALTIME_MAX_DEAD_AIR_MS,
      );
    }
  });

  it('speaks the acknowledgment before the agent turn, not after it is slow', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();

    expect(h.frames.filter((f) => f.t === 'realtime_speak')).toEqual([
      { t: 'realtime_speak', text: 'Let me check.', kind: 'ack' },
    ]);
  });

  it('stops the filler the moment the consult returns', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();
    h.clock.advanceTo(4_000);
    h.finish('c1');
    await settle();
    const spokenBefore = h.frames.filter((f) => f.t === 'realtime_speak').length;

    h.clock.advanceTo(30_000);

    expect(h.frames.filter((f) => f.t === 'realtime_speak')).toHaveLength(spokenBefore);
  });

  it('degrades on a provider that cannot speak verbatim: ack captioned, no repeats', async () => {
    // Gemini Live. The wire has no verbatim-speech frame, so repeating "One
    // moment." would be a caption with no audio behind it. The ack still goes,
    // because the browser captions it and the listener needs to see SOMETHING.
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: false });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();
    h.clock.advanceTo(30_000);

    expect(h.frames.filter((f) => f.t === 'realtime_speak')).toEqual([
      { t: 'realtime_speak', text: 'Let me check.', kind: 'ack' },
    ]);
  });
});

describe('realtime control lane — one lane, strict FIFO', () => {
  it('serializes two overlapping consults instead of interleaving them', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();

    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c2', name: 'agent_consult', args: {} });
    await settle();

    // c2 has not started: the lane is one-at-a-time.
    expect(h.order).toEqual(['start:c1']);

    h.finish('c1', 'first');
    await settle();
    expect(h.order).toEqual(['start:c1', 'end:c1', 'start:c2']);

    h.finish('c2', 'second');
    await settle();
    expect(h.order).toEqual(['start:c1', 'end:c1', 'start:c2', 'end:c2']);

    const results = h.frames.filter((f) => f.t === 'realtime_tool_result');
    expect(results).toEqual([
      { t: 'realtime_tool_result', callId: 'c1', ok: true, output: 'first' },
      { t: 'realtime_tool_result', callId: 'c2', ok: true, output: 'second' },
    ]);
  });

  it('a hangup aborts the running consult and drops the queue', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c2', name: 'agent_consult', args: {} });
    await settle();

    h.lane.handle({ t: 'realtime_end' });
    h.finish('c1');
    await settle();

    expect(h.order).toEqual(['start:c1', 'end:c1']);
    expect(h.frames.filter((f) => f.t === 'realtime_tool_result')).toEqual([]);
    expect(h.lane.isOpen).toBe(false);
  });
});

// $0.60/min is $0.01/second, so every number below is readable by eye: one
// 15 s accrual tick is $0.15.
const RATE_PER_MINUTE = 0.6;

describe('realtime control lane — per-audio-minute accrual', () => {
  it('prices wall-clock audio time, tick by tick, as usage events', async () => {
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();

    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS);
    expect(h.usage).toEqual([
      { type: 'usage', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0.15 },
    ]);

    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS * 2);
    expect(h.usage).toHaveLength(2);
    // Nothing was generated and nothing was said — the meter is the open socket.
    expect(h.spendUsd()).toBeCloseTo(0.3, 10);
  });

  it('bills the part-tick a hangup interrupts instead of dropping it', async () => {
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();

    // 40 s: two whole ticks and ten seconds that would otherwise be free.
    h.clock.advanceTo(40_000);
    h.lane.handle({ t: 'realtime_end' });

    expect(h.spendUsd()).toBeCloseTo(0.4, 10);
    expect(h.usage).toHaveLength(3);
  });

  it('accrues NOTHING for an unpriced entry, and says the cost is unknown', async () => {
    // `costPerMinuteUsd` absent means the rate is unknown, not zero. A $0.00
    // usage event for a session the provider is billing by the minute would be
    // a claim — and the flattering one.
    const h = harness({ sessionBudgetUsd: 0.01 });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.clock.advanceTo(10 * 60_000);

    expect(h.usage).toEqual([]);
    expect(h.halts).toEqual([]);
    expect(h.laneEvents).toContainEqual({ type: 'unpriced', laneKey: 'voice:web:browser:chat-9' });
    expect(h.lane.isOpen).toBe(true);
  });
});

describe('realtime control lane — budget wind-down', () => {
  it('speaks a sign-off and closes cleanly, in that order', async () => {
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE, sessionBudgetUsd: 0.3 });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();

    // Two ticks: $0.30 accrued against a $0.30 cap.
    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS * 2);

    // 1. the halt, in the vocabulary a turn halts in.
    expect(h.halts).toEqual([
      {
        type: 'halt',
        kind: 'budget',
        rule: 'cost-cap',
        toolName: '_budget',
        message: expect.stringContaining('budget cap for this session'),
      },
    ]);
    // 2. the sign-off, and 3. the answer for the consult that will never
    // return — both dispatched while the lane was still open, which is what
    // "before the close" means here.
    const tail = h.timeline.slice(-2);
    expect(tail).toEqual([
      { t: 'realtime_wind_down', open: true },
      { t: 'realtime_tool_result', open: true },
    ]);
    expect(h.frames.at(-2)).toEqual({
      t: 'realtime_wind_down',
      text: REALTIME_BUDGET_SIGN_OFF,
      reason: 'budget',
    });
    expect(h.frames.at(-1)).toEqual({
      t: 'realtime_tool_result',
      callId: 'c1',
      ok: false,
      output: 'This call reached its spending limit before that finished.',
    });
    // 4. and only then the close.
    expect(h.lane.isOpen).toBe(false);
  });

  it('emits nothing at all after the close', async () => {
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE, sessionBudgetUsd: 0.15 });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    await settle();
    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS);
    const settled = h.frames.length;
    const usageSettled = h.usage.length;

    // The consult comes back late, more audio time "passes", and another tool
    // call arrives from a provider that has not noticed yet.
    h.finish('c1');
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c2', name: 'agent_consult', args: {} });
    h.lane.handle({ t: 'realtime_transcript', role: 'user', text: 'still there?' });
    h.clock.advanceTo(10 * 60_000);
    await settle();

    expect(h.frames).toHaveLength(settled);
    expect(h.usage).toHaveLength(usageSettled);
    expect(h.halts).toHaveLength(1);
    expect(h.transcripts).toEqual([]);
  });

  it('winds down on a provider that cannot speak verbatim, too', async () => {
    // Gemini Live. The frame still goes: the browser captions it, and a call
    // that ends without a word is the dropped stream this criterion forbids.
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE, sessionBudgetUsd: 0.15 });
    h.lane.handle({ t: 'realtime_start', canSay: false });
    await settle();
    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS);

    expect(h.frames.filter((f) => f.t === 'realtime_wind_down')).toEqual([
      { t: 'realtime_wind_down', text: REALTIME_BUDGET_SIGN_OFF, reason: 'budget' },
    ]);
    expect(h.lane.isOpen).toBe(false);
  });

  it('counts what the consults spent, not only the audio', async () => {
    // The cap is what this CALL costs. A session whose audio is cheap and whose
    // agent turns are not is exactly the case a per-audio-minute-only cap would
    // never catch.
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE, sessionBudgetUsd: 1 });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.addConsultSpend(0.9);

    h.clock.advanceTo(REALTIME_ACCRUAL_INTERVAL_MS);

    expect(h.spendUsd()).toBeCloseTo(1.05, 10);
    expect(h.halts).toHaveLength(1);
    expect(h.lane.isOpen).toBe(false);
  });

  it('does not wind down a call that is already hanging up', async () => {
    // The final part-tick can cross the cap on the way out. There is nothing
    // left to wind down from, and a sign-off spoken into a closing socket is a
    // line nobody hears.
    const h = harness({ costPerMinuteUsd: RATE_PER_MINUTE, sessionBudgetUsd: 0.05 });
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.clock.advanceTo(5_000);
    h.lane.handle({ t: 'realtime_end' });

    expect(h.spendUsd()).toBeCloseTo(0.05, 10);
    expect(h.halts).toEqual([]);
    expect(h.frames.filter((f) => f.t === 'realtime_wind_down')).toEqual([]);
  });
});

describe('realtime control lane — transcripts', () => {
  it('persists settled transcripts for both roles, in order', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();

    h.lane.handle({ t: 'realtime_transcript', role: 'user', text: 'what did we decide?' });
    h.lane.handle({ t: 'realtime_transcript', role: 'assistant', text: 'Friday.' });
    await settle();

    expect(h.transcripts).toEqual([
      { role: 'user', text: 'what did we decide?' },
      { role: 'assistant', text: 'Friday.' },
    ]);
  });

  it('does not park transcript writes behind a slow consult', async () => {
    const h = harness();
    h.lane.handle({ t: 'realtime_start', canSay: true });
    await settle();
    h.lane.handle({ t: 'realtime_tool_call', callId: 'c1', name: 'agent_consult', args: {} });
    h.lane.handle({ t: 'realtime_transcript', role: 'user', text: 'still talking' });
    await settle();

    expect(h.transcripts).toEqual([{ role: 'user', text: 'still talking' }]);
  });
});
