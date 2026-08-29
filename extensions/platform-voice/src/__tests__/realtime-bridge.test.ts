import type { PcmChunk, RealtimeVoiceProvider } from '@ethosagent/types';
import {
  createFakeRealtimeProvider,
  type FakeRealtimeOptions,
  type FakeRealtimeSession,
} from '@ethosagent/voice-providers';
import { describe, expect, it } from 'vitest';
import { muLawToPcm16, pcm16ToMuLaw } from '../sip/g711';
import {
  createSipRealtimeBridge,
  type SipBridgeEvent,
  type SipToolCall,
  type SipWireCodec,
} from '../sip/realtime-bridge';
import { FakeVoiceTransport, makeTimerScheduler, settle } from './fakes';

const WIRE_RATE = 8000;
const FRAME_SAMPLES = 160;
/** 100 ms of constant tone at the fake provider's 24 kHz output rate. */
const REPLY_SAMPLES = 2400;

function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes;
}

interface Harness {
  provider: RealtimeVoiceProvider;
  transport: FakeVoiceTransport;
  scheduler: ReturnType<typeof makeTimerScheduler>;
  events: SipBridgeEvent[];
  toolCalls: SipToolCall[];
  /** Ordering trace: pacer cancels and provider interrupts, interleaved. */
  order: string[];
  sessions: FakeRealtimeSession[];
  closes: number;
  bridge: ReturnType<typeof createSipRealtimeBridge>;
}

function makeHarness(
  opts: { codec?: SipWireCodec; fake?: FakeRealtimeOptions; toolOutput?: string } = {},
): Harness {
  const fake = createFakeRealtimeProvider({
    reply: { pcm: pcmBytes(new Int16Array(REPLY_SAMPLES).fill(9000)) },
    ...opts.fake,
  });
  const sessions: FakeRealtimeSession[] = [];
  const order: string[] = [];
  const harness: Harness = {
    provider: {
      name: fake.name,
      caps: fake.caps,
      async open(sessionOptions) {
        const live = await fake.open(sessionOptions);
        sessions.push(live);
        // Wrapped so the ordering of `pacer.cancel()` vs `session.interrupt()`
        // is OBSERVED rather than assumed — the barge-in test asserts it.
        return {
          ...live,
          interrupt: async () => {
            order.push('interrupt');
            await live.interrupt();
          },
          close: async () => {
            harness.closes += 1;
            await live.close();
          },
        };
      },
    },
    transport: new FakeVoiceTransport('+15551234567'),
    scheduler: makeTimerScheduler(),
    events: [],
    toolCalls: [],
    order,
    sessions,
    closes: 0,
    // Replaced immediately below; the field exists so `harness` can be
    // referenced from the wrappers above.
    bridge: undefined as unknown as ReturnType<typeof createSipRealtimeBridge>,
  };

  harness.bridge = createSipRealtimeBridge({
    provider: harness.provider,
    sessionOptions: { instructions: 'you are on a phone call' },
    transport: harness.transport,
    toolHost: {
      dispatch: async (call) => {
        harness.toolCalls.push(call);
        return { ok: true, output: opts.toolOutput ?? 'it is sunny in London' };
      },
    },
    ...(opts.codec ? { codec: opts.codec } : {}),
    wireSampleRate: WIRE_RATE,
    now: harness.scheduler.now,
    setTimer: (fn, ms) => {
      const timer = harness.scheduler.setTimer(fn, ms);
      return {
        cancel: () => {
          order.push('pacer_cancel');
          timer.cancel();
        },
      };
    },
    onEvent: (event) => harness.events.push(event),
  });
  return harness;
}

/** Inbound narrowband PCM from the phone, one 20 ms frame. */
function callerFrame(value = 6000): PcmChunk {
  return { data: new Int16Array(FRAME_SAMPLES).fill(value), sampleRate: WIRE_RATE };
}

/** Drain every frame the pacer has queued. */
function drainPacer(scheduler: ReturnType<typeof makeTimerScheduler>): void {
  let guard = 0;
  while (scheduler.fire() && guard++ < 1000) {
    // paced emission
  }
}

describe('createSipRealtimeBridge', () => {
  it('pre-warms one session and start() reuses it', async () => {
    const h = makeHarness();
    await h.bridge.prewarm();
    expect(h.sessions.length).toBe(1);
    expect(h.transport.connected).toBe(false);

    await h.bridge.start();
    // The whole point of the pre-warm: no second socket, no second bill.
    expect(h.sessions.length).toBe(1);
    expect(h.transport.connected).toBe(true);
    await h.bridge.stop();
  });

  it('runs a full turn: caller audio in, transcript and paced audio out', async () => {
    const h = makeHarness();
    await h.bridge.start();

    h.transport.emit(callerFrame());
    await settle();
    // Caller audio reached the provider, upsampled 8k -> 16k (2 bytes/sample).
    expect(h.sessions[0]?.audioIn.length).toBe(1);
    expect(h.sessions[0]?.audioIn[0]?.length).toBe(FRAME_SAMPLES * 2 * 2);

    drainPacer(h.scheduler);
    // 2400 samples at 24 kHz -> 800 at 8 kHz -> exactly five 20 ms frames.
    expect(h.transport.sentAudio.length).toBe(5);
    expect(h.transport.sentAudio[0]?.format).toBe('pcm');
    expect(h.transport.sentAudio[0]?.audio.length).toBe(FRAME_SAMPLES * 2);

    expect(h.bridge.transcript()).toBe('user: what is the weather\nassistant: it is sunny');
    await h.bridge.stop();
  });

  it('cancels the pacer BEFORE interrupting on barge-in', async () => {
    const h = makeHarness();
    await h.bridge.start();
    h.transport.emit(callerFrame());
    await settle();

    // One frame out; the rest are queued with a timer pending.
    expect(h.scheduler.fire()).toBe(true);
    expect(h.scheduler.scheduledAt()).not.toBeNull();
    const before = h.transport.sentAudio.length;

    h.sessions[0]?.emit({ type: 'speech_started' });
    await settle();

    // ORDER IS THE BEHAVIOUR. Interrupting first would leave the queue playing
    // over the caller for as long as it holds.
    expect(h.order).toEqual(['pacer_cancel', 'interrupt']);
    expect(h.events.some((e) => e.type === 'barge_in')).toBe(true);
    // Nothing further played: the queue is gone and no timer is pending.
    expect(h.scheduler.fire()).toBe(false);
    expect(h.transport.sentAudio.length).toBe(before);
    await h.bridge.stop();
  });

  it('drops audio for a superseded response and plays the next one', async () => {
    const h = makeHarness();
    await h.bridge.start();
    h.transport.emit(callerFrame());
    await settle();
    h.scheduler.fire();

    h.sessions[0]?.emit({ type: 'speech_started' });
    await settle();
    const playedAtBargeIn = h.transport.sentAudio.length;

    // In-flight audio from the response the caller talked over.
    h.sessions[0]?.emit({
      type: 'audio',
      pcm: pcmBytes(new Int16Array(REPLY_SAMPLES).fill(1000)),
      sampleRate: 24_000,
    });
    await settle();
    expect(h.events.some((e) => e.type === 'audio_dropped' && e.reason === 'superseded')).toBe(
      true,
    );
    drainPacer(h.scheduler);
    expect(h.transport.sentAudio.length).toBe(playedAtBargeIn);

    // A transcript marks the new exchange; audio after it is fresh and plays.
    h.sessions[0]?.emit({ type: 'transcript', role: 'user', text: 'actually', isFinal: true });
    h.sessions[0]?.emit({
      type: 'audio',
      pcm: pcmBytes(new Int16Array(REPLY_SAMPLES).fill(1000)),
      sampleRate: 24_000,
    });
    await settle();
    drainPacer(h.scheduler);
    expect(h.transport.sentAudio.length).toBe(playedAtBargeIn + 5);
    await h.bridge.stop();
  });

  it('round-trips a tool call through the host', async () => {
    const h = makeHarness({
      fake: { reply: { toolCall: { name: 'weather_lookup', args: { city: 'London' } } } },
    });
    await h.bridge.start();
    h.transport.emit(callerFrame());
    await settle();

    expect(h.toolCalls.map((c) => c.name)).toEqual(['weather_lookup']);
    expect(h.sessions[0]?.toolResults).toEqual([
      { callId: 'call-1', output: 'it is sunny in London' },
    ]);
    expect(h.events.some((e) => e.type === 'tool_dispatched' && e.ok)).toBe(true);
    await h.bridge.stop();
  });

  it('answers a tool call even when the host throws', async () => {
    const fake = createFakeRealtimeProvider({
      reply: { toolCall: { name: 'weather_lookup', args: {} } },
    });
    const sessions: FakeRealtimeSession[] = [];
    const transport = new FakeVoiceTransport('+15550000000');
    const events: SipBridgeEvent[] = [];
    const bridge = createSipRealtimeBridge({
      provider: {
        name: fake.name,
        caps: fake.caps,
        open: async (o) => {
          const live = await fake.open(o);
          sessions.push(live);
          return live;
        },
      },
      sessionOptions: { instructions: 'x' },
      transport,
      toolHost: {
        dispatch: () => Promise.reject(new Error('tool exploded')),
      },
      wireSampleRate: WIRE_RATE,
      onEvent: (event) => events.push(event),
    });

    await bridge.start();
    transport.emit(callerFrame());
    await settle();

    // An unanswered tool call leaves a realtime session waiting forever, and
    // forever is what the caller hears.
    expect(sessions[0]?.toolResults.length).toBe(1);
    expect(
      events.some((e) => e.type === 'provider_error' && e.code === 'realtime_tool_failed'),
    ).toBe(true);
    await bridge.stop();
  });

  it('surfaces a provider error without throwing out of the pump', async () => {
    const h = makeHarness();
    await h.bridge.start();

    h.sessions[0]?.emit({ type: 'error', error: 'socket reset', code: 'realtime_error' });
    await settle();

    expect(h.events).toContainEqual({
      type: 'provider_error',
      error: 'socket reset',
      code: 'realtime_error',
    });
    // Still live: a recoverable error is not a hang-up.
    h.transport.emit(callerFrame());
    await settle();
    expect(h.sessions[0]?.audioIn.length).toBe(1);
    await h.bridge.stop();
  });

  it('stop() closes the session and the transport exactly once', async () => {
    const h = makeHarness();
    await h.bridge.start();
    await h.bridge.stop();
    await h.bridge.stop();

    expect(h.closes).toBe(1);
    expect(h.transport.connected).toBe(false);
    // Audio arriving after teardown has nowhere to go and must not throw.
    h.transport.emit(callerFrame());
    await settle();
  });

  it('carries a g711u leg in both directions', async () => {
    const h = makeHarness({ codec: 'g711u' });
    await h.bridge.start();

    // INBOUND: the transport carries μ-law bytes in the chunk's byte view.
    const muLaw = pcm16ToMuLaw(new Int16Array(FRAME_SAMPLES).fill(6000));
    h.transport.emit({
      data: new Int16Array(muLaw.buffer, 0, muLaw.length / 2),
      sampleRate: WIRE_RATE,
    });
    await settle();
    // 160 μ-law bytes -> 160 samples at 8 kHz -> 320 samples at 16 kHz -> 640 bytes.
    expect(h.sessions[0]?.audioIn[0]?.length).toBe(640);

    // OUTBOUND: one byte per sample, and it decodes back to the tone.
    drainPacer(h.scheduler);
    const frame = h.transport.sentAudio[0];
    expect(frame?.audio.length).toBe(FRAME_SAMPLES);
    const decoded = muLawToPcm16(frame?.audio ?? new Uint8Array());
    expect(Math.abs((decoded[0] ?? 0) - 9000)).toBeLessThan(300);
    await h.bridge.stop();
  });

  it('drops provider audio that arrives before the leg is connected', async () => {
    const h = makeHarness();
    await h.bridge.prewarm();

    h.sessions[0]?.emit({
      type: 'audio',
      pcm: pcmBytes(Int16Array.from([1, 2])),
      sampleRate: 24_000,
    });
    await settle();

    expect(h.events.some((e) => e.type === 'audio_dropped' && e.reason === 'not_connected')).toBe(
      true,
    );
    expect(h.transport.sentAudio.length).toBe(0);
    await h.bridge.stop();
  });
});
