import type { RealtimeEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateRealtimeProvider } from '../realtime-conformance';
import { createFakeRealtimeProvider, type FakeRealtimeSession } from '../realtime-fake';

// What a caller is allowed to rely on when it drives the fake instead of a
// provider. Everything here is timing-free apart from the zero-delay timers the
// fake's own VAD uses, so a caller's test never sleeps for a fixed budget.

/** Drain events until `predicate` is satisfied, then return everything seen. */
async function drainUntil(
  session: FakeRealtimeSession,
  predicate: (seen: RealtimeEvent[]) => boolean,
): Promise<RealtimeEvent[]> {
  const seen: RealtimeEvent[] = [];
  for await (const event of session.events) {
    seen.push(event);
    if (predicate(seen)) break;
  }
  return seen;
}

const types = (events: RealtimeEvent[]): string[] => events.map((e) => e.type);

describe('fake realtime provider', () => {
  it('satisfies the realtime provider contract statically', () => {
    // It stands in for a provider in tests, so a shape the contract would
    // reject makes those tests prove nothing.
    expect(validateRealtimeProvider(createFakeRealtimeProvider())).toEqual([]);
    expect(createFakeRealtimeProvider().caps.local).toBe(true);
  });

  it('opens, records what the caller wrote, and terminates the stream on close', async () => {
    const provider = createFakeRealtimeProvider();
    const session = await provider.open({ instructions: 'You are under test.' });

    expect(provider.opened[0]?.instructions).toBe('You are under test.');
    const frame = new Uint8Array([1, 2, 3, 4]);
    await session.sendAudio(frame);
    expect(session.audioIn).toEqual([frame]);

    const seen = await drainUntil(session, (events) =>
      events.some((e) => e.type === 'response_done'),
    );
    expect(types(seen)).toEqual([
      'session_open',
      'transcript',
      'transcript',
      'audio',
      'response_done',
    ]);

    await session.close();
    const rest: RealtimeEvent[] = [];
    for await (const event of session.events) rest.push(event);
    // The iterable COMPLETES after `closed` — a consumer parked on it is not
    // left hanging when the session goes away.
    expect(types(rest)).toEqual(['closed']);
  });

  it('commits a turn on silence and marks it with the settled user transcript', async () => {
    const provider = createFakeRealtimeProvider({ reply: { userTranscript: 'hello there' } });
    const session = await provider.open({ instructions: 'x' });
    await session.sendAudio(new Uint8Array([0, 0]));

    const seen = await drainUntil(session, (events) => events.some((e) => e.type === 'audio'));
    expect(seen).toContainEqual({
      type: 'transcript',
      role: 'user',
      text: 'hello there',
      isFinal: true,
    });
    await session.close();
  });

  it('withholds the commit marker for a provider that transcribes asynchronously', async () => {
    const provider = createFakeRealtimeProvider({ emitCommitMarker: false });
    const session = await provider.open({ instructions: 'x' });
    await session.sendAudio(new Uint8Array([0, 0]));

    const seen = await drainUntil(session, (events) => events.some((e) => e.type === 'audio'));
    expect(seen.filter((e) => e.type === 'transcript' && e.role === 'user')).toEqual([]);
    await session.close();
  });

  it('pauses the turn on a tool call and speaks only once it is answered', async () => {
    const provider = createFakeRealtimeProvider({
      reply: { toolCall: { name: 'lookup', args: { query: 'weather' } } },
    });
    const session = await provider.open({ instructions: 'x' });
    await session.sendAudio(new Uint8Array([0, 0]));

    const upToCall = await drainUntil(session, (events) =>
      events.some((e) => e.type === 'tool_call'),
    );
    const call = upToCall.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ name: 'lookup', args: { query: 'weather' } });
    // Nothing was spoken while the call was outstanding.
    expect(types(upToCall)).not.toContain('audio');

    if (call?.type !== 'tool_call') throw new Error('no tool call to answer');
    await session.sendToolResult(call.callId, '{"temp":21}');
    expect(session.toolResults).toEqual([{ callId: call.callId, output: '{"temp":21}' }]);

    const after = await drainUntil(session, (events) =>
      events.some((e) => e.type === 'response_done'),
    );
    expect(types(after)).toEqual(['transcript', 'audio', 'response_done']);
    await session.close();
  });

  it('drops the in-flight response when the caller barges in', async () => {
    const provider = createFakeRealtimeProvider({ audioMs: 50 });
    const session = await provider.open({ instructions: 'x' });
    await session.sendAudio(new Uint8Array([0, 0]));

    // Barge in AFTER the turn committed and while the reply is still in flight
    // — `interrupt()` cancels speech, it does not un-hear the user's audio.
    await drainUntil(session, (events) =>
      events.some((e) => e.type === 'transcript' && e.role === 'user'),
    );
    await session.interrupt();
    expect(session.interrupts).toBe(1);

    // Wait past the reply delay: the cancelled speech must never arrive.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await session.close();
    const seen = await drainUntil(session, (events) => events.some((e) => e.type === 'closed'));
    expect(types(seen)).toEqual(['closed']);
  });

  it('lets a caller script an event the scripted turn does not produce', async () => {
    const provider = createFakeRealtimeProvider();
    const session = await provider.open({ instructions: 'x' });
    session.emit({ type: 'speech_started' });
    session.emit({ type: 'error', error: 'rate limited', code: 'rate_limit_exceeded' });

    const seen = await drainUntil(session, (events) => events.some((e) => e.type === 'error'));
    expect(types(seen)).toEqual(['session_open', 'speech_started', 'error']);
    await session.close();
  });
});
