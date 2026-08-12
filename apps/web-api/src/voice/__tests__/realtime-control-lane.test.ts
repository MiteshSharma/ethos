import type { RealtimeToolHost } from '@ethosagent/tools-voice';
import type { VoiceServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  REALTIME_MAX_DEAD_AIR_MS,
  RealtimeControlLane,
  type RealtimeControlLaneDeps,
  type RealtimeSessionBinding,
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
}

function harness(opts: { laneKey?: string; handled?: string[] } = {}): Harness {
  const clock = new FakeClock();
  const frames: VoiceServerFrame[] = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  const order: string[] = [];
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
  };

  const deps: RealtimeControlLaneDeps = {
    open: async () => binding,
    persistTranscript: async (_binding, role, text) => {
      transcripts.push({ role, text });
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };

  const lane = new RealtimeControlLane({ deps, send: (frame) => frames.push(frame) });
  return {
    lane,
    frames,
    clock,
    transcripts,
    order,
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
