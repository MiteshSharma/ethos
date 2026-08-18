import type { PcmChunk, StreamingSttProvider } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../transcript-session';
import { runTranscriptSession } from '../transcript-session';

const SAMPLE_RATE = 16_000;

/** Yields `totalSamples` worth of constant-value PCM, split into
 * `chunkSamples`-sized `PcmChunk`s — enough to drive the windower without
 * caring about actual audio content. */
async function* pcmStream(totalSamples: number, chunkSamples = 1600): AsyncGenerator<PcmChunk> {
  let remaining = totalSamples;
  while (remaining > 0) {
    const n = Math.min(chunkSamples, remaining);
    yield { data: new Int16Array(n).fill(100), sampleRate: SAMPLE_RATE };
    remaining -= n;
  }
}

async function* emptyStream(): AsyncGenerator<PcmChunk> {
  // yields nothing — an empty capture stream
}

/** A fake `StreamingSttProvider` that counts `transcribeStream()` calls and
 * returns caller-controlled text per call, draining its input the same way
 * a real provider would. */
function createFakeStreamingStt(textForCall: (callNumber: number) => string): {
  provider: StreamingSttProvider;
  callCount: () => number;
} {
  let calls = 0;
  const provider: StreamingSttProvider = {
    name: 'fake-streaming-stt',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: STT_CONTRACT_VERSION },
    async transcribeBuffer() {
      throw new Error('transcribeBuffer should not be called when caps.streaming is true');
    },
    async *transcribeStream(audio) {
      calls += 1;
      for await (const _chunk of audio) {
        // drain, same as a real provider consuming the utterance
      }
      yield { text: textForCall(calls), isFinal: true };
    },
  };
  return { provider, callCount: () => calls };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('runTranscriptSession — windowing boundaries', () => {
  it('closes a window and calls transcribeStream exactly once per full window', async () => {
    const { provider, callCount } = createFakeStreamingStt((n) => `window-${n}`);
    // windowMs=1000 @ 16kHz => 16000 samples per window; 32000 samples = exactly 2 windows.
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(32_000), tap: emptyStream() }, provider, {
        windowMs: 1000,
      }),
    );

    expect(callCount()).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.speaker === 'you')).toBe(true);
    expect(entries.map((e) => e.text).sort()).toEqual(['window-1', 'window-2']);
  });

  it('flushes a trailing partial window when the source stream ends mid-window', async () => {
    const { provider, callCount } = createFakeStreamingStt(() => 'partial');
    // Only 8000 samples (0.5s) — half of a 1000ms window; stream ends there.
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(8_000), tap: emptyStream() }, provider, {
        windowMs: 1000,
      }),
    );

    expect(callCount()).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('partial');
  });

  it('drops windows whose transcription is empty/blank rather than yielding a noise entry', async () => {
    const { provider } = createFakeStreamingStt((n) => (n === 1 ? '' : '  ')); // both blank
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(32_000), tap: emptyStream() }, provider, {
        windowMs: 1000,
      }),
    );

    expect(entries).toEqual([]);
  });

  it('drops windows whose transcription is a known STT hallucination pattern', async () => {
    // "you" and "Thanks for watching!" are both entries in
    // HALLUCINATION_PATTERNS (packages/voice-text/src/hallucination.ts) —
    // classic Whisper-on-silence boilerplate, not genuine speech.
    const { provider } = createFakeStreamingStt((n) => (n === 1 ? 'you' : 'Thanks for watching!'));
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(32_000), tap: emptyStream() }, provider, {
        windowMs: 1000,
      }),
    );

    expect(entries).toEqual([]);
  });

  it('does not over-match a genuine transcript that merely contains "you" as a word', async () => {
    // isHallucination()'s patterns are anchored (e.g. `^you$`), so a real
    // sentence that happens to include "you" must still pass through.
    const { provider } = createFakeStreamingStt(() => 'Can you send me the deck before the call?');
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(16_000), tap: emptyStream() }, provider, {
        windowMs: 1000,
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('Can you send me the deck before the call?');
  });
});

describe('runTranscriptSession — two-stream independence', () => {
  it('yields both mic ("you") and tap ("other") entries, correctly speaker-labeled', async () => {
    const { provider, callCount } = createFakeStreamingStt((n) => `text-${n}`);
    const entries = await collect(
      runTranscriptSession({ mic: pcmStream(16_000), tap: pcmStream(16_000) }, provider, {
        windowMs: 1000,
      }),
    );

    // One window each, transcribed independently — two separate calls, never
    // one call over pre-mixed audio (decision 7's resolved footgun #3).
    expect(callCount()).toBe(2);
    expect(entries).toHaveLength(2);

    const speakers = entries.map((e) => e.speaker).sort();
    expect(speakers).toEqual(['other', 'you']);
  });

  it('produces entries that can be merged into chronological order by `at`', async () => {
    const { provider } = createFakeStreamingStt((n) => `text-${n}`);
    const entries: TranscriptEntry[] = await collect(
      runTranscriptSession({ mic: pcmStream(16_000), tap: pcmStream(16_000) }, provider, {
        windowMs: 1000,
      }),
    );

    const sorted = [...entries].sort((a, b) => a.at - b.at);
    expect(sorted).toHaveLength(entries.length);
    for (const entry of sorted) {
      expect(typeof entry.at).toBe('number');
      expect(entry.at).toBeGreaterThan(0);
    }
  });
});
