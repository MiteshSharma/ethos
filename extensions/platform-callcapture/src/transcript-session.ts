// transcript-session.ts — windowed streamed STT over the two independent
// Phase 3 capture streams (plan/phases/call-capture-extension.md decision 2
// + decision 7's speaker attribution). Runs the mic stream ("You") and the
// tap stream ("Other participant") through INDEPENDENT STT passes — never
// pre-mixed — and yields speaker-labeled `TranscriptEntry` values as each
// window's transcription completes. See README.md "Phase 3" for why fixed
// time-windowing, not VAD endpointing, is this spike's simplification.
//
// Reuses `@ethosagent/types`' streaming STT contract directly:
// `isStreamingSttProvider` / `createBufferedSttAdapter` is the exact
// resolve-once pattern `extensions/voice-session/src/voice-session.ts` uses
// (`resolveStt()`), and `transcribeStream()` is called once per window the
// same way `voice-session.ts` calls it once per utterance
// (`handleUtterance()` / `transcribe()`).

import type { PcmChunk, StreamingSttProvider, SttProvider } from '@ethosagent/types';
import { isStreamingSttProvider } from '@ethosagent/types';
import { createBufferedSttAdapter } from '@ethosagent/voice-session';
import { isHallucination } from '@ethosagent/voice-text';

/** Decision 7's exact labels — "You" (mic) / "Other participant" (tap). */
export type Speaker = 'you' | 'other';

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  /** Wall-clock ms when this window started capturing. */
  at: number;
}

export interface TranscriptSessionOptions {
  /**
   * Fixed window duration in ms. A window closes (and triggers exactly one
   * `transcribeStream()` call) once its accumulated audio reaches this
   * duration. Default 8000ms (decision 2's "8-10s" guidance) — a scoped-down
   * spike simplification, not production endpointing; see README.md
   * "Phase 3" for what a VAD-based follow-up would replace this with.
   */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 8_000;

interface PcmWindow {
  chunks: PcmChunk[];
  at: number;
}

/** Groups a `PcmChunk` stream into fixed-duration windows by accumulated
 * sample count (not wall-clock time — robust to producer jitter). The final
 * partial window (if any) is flushed when the source stream ends, so no
 * trailing audio is silently dropped when capture is stopped mid-window. */
async function* windowPcmStream(
  stream: AsyncIterable<PcmChunk>,
  windowMs: number,
): AsyncGenerator<PcmWindow> {
  let chunks: PcmChunk[] = [];
  let accumulatedSamples = 0;
  let windowStartedAt: number | null = null;
  let sampleRate = 16_000;

  for await (const chunk of stream) {
    if (windowStartedAt === null) windowStartedAt = Date.now();
    sampleRate = chunk.sampleRate;
    chunks.push(chunk);
    accumulatedSamples += chunk.data.length;

    const windowDurationMs = (accumulatedSamples / sampleRate) * 1000;
    if (windowDurationMs >= windowMs) {
      yield { chunks, at: windowStartedAt };
      chunks = [];
      accumulatedSamples = 0;
      windowStartedAt = null;
    }
  }

  if (chunks.length > 0 && windowStartedAt !== null) {
    yield { chunks, at: windowStartedAt };
  }
}

async function* asyncIterableFrom<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Runs windowed streamed transcription over one speaker's stream,
 * yielding one `TranscriptEntry` per non-empty, non-hallucinated window —
 * exactly one `transcribeStream()` call per window, per decision 2's
 * streaming requirement. Empty/silent windows (STT returns blank text) and
 * windows whose text is a known Whisper-on-silence hallucination (per
 * `isHallucination()` from `@ethosagent/voice-text`) are dropped rather
 * than yielded as noise entries. */
async function* transcribeWindows(
  stream: AsyncIterable<PcmChunk>,
  speaker: Speaker,
  stt: StreamingSttProvider,
  windowMs: number,
): AsyncGenerator<TranscriptEntry> {
  for await (const window of windowPcmStream(stream, windowMs)) {
    let text = '';
    for await (const partial of stt.transcribeStream(asyncIterableFrom(window.chunks))) {
      text = partial.text;
    }
    const trimmed = text.trim();
    if (isHallucination(trimmed)) continue;
    yield { speaker, text: trimmed, at: window.at };
  }
}

/** Fans in several async generators, yielding each value as soon as its
 * source generator produces it (real interleaving order, not source order).
 * Used to run the mic and tap windowers concurrently rather than draining
 * one stream before starting the other. */
interface MergeEntry<T> {
  gen: AsyncGenerator<T>;
  pending: Promise<IteratorResult<T>>;
}

async function* mergeAsyncGenerators<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const live = new Map<number, MergeEntry<T>>(
    generators.map((gen, i) => [i, { gen, pending: gen.next() }]),
  );

  while (live.size > 0) {
    const race = await Promise.race(
      [...live.entries()].map(async ([i, entry]) => ({ i, result: await entry.pending })),
    );
    if (race.result.done) {
      live.delete(race.i);
      continue;
    }
    yield race.result.value;
    const entry = live.get(race.i);
    if (entry) entry.pending = entry.gen.next();
  }
}

/**
 * Runs Phase 3's dual-stream windowed transcription: the mic stream ("You")
 * and the tap stream ("Other participant") are transcribed independently —
 * two separate `transcribeStream()` call sequences, never pre-mixed audio —
 * and yielded as `TranscriptEntry` values as soon as each window completes.
 * Callers wanting a final chronological transcript should collect entries
 * and sort by `at`, since real-time completion order across two independent
 * streams is not itself guaranteed to match wall-clock speaking order.
 */
export function runTranscriptSession(
  streams: { mic: AsyncIterable<PcmChunk>; tap: AsyncIterable<PcmChunk> },
  sttProvider: SttProvider,
  options: TranscriptSessionOptions = {},
): AsyncGenerator<TranscriptEntry> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const stt: StreamingSttProvider = isStreamingSttProvider(sttProvider)
    ? sttProvider
    : createBufferedSttAdapter(sttProvider);

  return mergeAsyncGenerators([
    transcribeWindows(streams.mic, 'you', stt, windowMs),
    transcribeWindows(streams.tap, 'other', stt, windowMs),
  ]);
}
