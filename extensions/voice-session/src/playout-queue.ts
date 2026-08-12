// Ordered playout of synthesized reply audio. Sentence N+1 is synthesized
// while sentence N is still playing (prefetch), but audio is emitted strictly
// in enqueue order — overlap buys latency, never reordering. `cancel()` flushes
// pending items and aborts every in-flight synthesis (barge-in). Tracks which
// sentences were actually played to their end, so the session can persist an
// honest interrupted reply.

import type { AudioFormat } from './types';

/**
 * How many not-yet-playing sentences are synthesized ahead of the current one.
 * One is enough to hide a synthesis round-trip behind the sentence being
 * spoken; more would burn provider calls on text a barge-in is about to throw
 * away.
 */
const PREFETCH_LOOKAHEAD = 1;

export interface PlayoutItem {
  /** The sentence text this audio corresponds to (for honest played-text tracking). */
  text: string;
  /** Lazily synthesizes the sentence; aborted via `signal` on cancel. */
  synthesize: (signal: AbortSignal) => AsyncIterable<{ audio: Uint8Array; format: AudioFormat }>;
}

export interface PlayoutQueueCallbacks {
  /** Called per audio chunk as it becomes available for playout. */
  onAudio: (audio: Uint8Array, format: AudioFormat, text: string) => void;
  /** Called once a sentence has fully played (all chunks emitted, not cancelled). */
  onSentencePlayed?: (text: string) => void;
  /** Called on a synthesis error that was not caused by cancellation. */
  onError?: (err: unknown) => void;
}

/**
 * A sentence whose synthesis has started. Chunks accumulate here as the
 * provider produces them; the drain loop emits them when the sentence's turn
 * comes. That buffer IS the prefetch.
 */
interface StartedItem {
  text: string;
  controller: AbortController;
  chunks: Array<{ audio: Uint8Array; format: AudioFormat }>;
  done: boolean;
  failed: boolean;
  error: unknown;
  /** Resolver for a drain loop waiting on the next chunk. */
  notify: (() => void) | null;
}

export class PlayoutQueue {
  private readonly callbacks: PlayoutQueueCallbacks;
  /** Enqueued but not yet synthesizing — beyond the prefetch window. */
  private queue: PlayoutItem[] = [];
  /** Synthesizing or synthesized, in playout order. Head is the one playing. */
  private started: StartedItem[] = [];
  private draining = false;
  private cancelled = false;
  private playedSentences: string[] = [];
  private drainPromise: Promise<void> | null = null;

  constructor(callbacks: PlayoutQueueCallbacks) {
    this.callbacks = callbacks;
  }

  enqueue(item: PlayoutItem): void {
    if (this.cancelled) return;
    this.queue.push(item);
    this.fill();
    this.ensureDraining();
  }

  /** Start synthesis for the playing sentence plus the lookahead window. */
  private fill(): void {
    const capacity = 1 + PREFETCH_LOOKAHEAD;
    while (!this.cancelled && this.started.length < capacity) {
      const item = this.queue.shift();
      if (!item) return;
      this.started.push(startSynthesis(item));
    }
  }

  private ensureDraining(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled) {
      const active = this.started[0];
      if (!active) break;
      const completed = await this.play(active);
      this.started.shift();
      if (this.cancelled || !completed) break;
      this.playedSentences.push(active.text);
      this.callbacks.onSentencePlayed?.(active.text);
      // A slot just freed: pull the next sentence into the prefetch window.
      this.fill();
    }
  }

  /** Emit one sentence's chunks in order. Returns false if it did not finish. */
  private async play(active: StartedItem): Promise<boolean> {
    let index = 0;
    while (!this.cancelled) {
      const chunk = active.chunks[index];
      if (chunk) {
        index += 1;
        this.callbacks.onAudio(chunk.audio, chunk.format, active.text);
        continue;
      }
      if (active.failed) {
        this.callbacks.onError?.(active.error);
        return false;
      }
      if (active.done) return true;
      await new Promise<void>((resolve) => {
        active.notify = resolve;
      });
    }
    return false;
  }

  /** Flush pending items and abort in-flight synthesis (barge-in). */
  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    for (const item of this.started) {
      item.controller.abort();
      // Wake a drain loop parked on this item so it observes the cancel.
      wake(item);
    }
  }

  /** Resolves when the current drain (if any) finishes. */
  async idle(): Promise<void> {
    if (this.drainPromise) await this.drainPromise;
  }

  /** Sentences that fully played, in order. */
  playedText(): string[] {
    return [...this.playedSentences];
  }

  /** True while draining or with items still pending. */
  get active(): boolean {
    return this.draining || this.queue.length > 0 || this.started.length > 0;
  }

  /** Clear all state for a fresh turn. */
  reset(): void {
    for (const item of this.started) item.controller.abort();
    this.cancelled = false;
    this.queue = [];
    this.started = [];
    this.playedSentences = [];
  }
}

/**
 * Kick off synthesis immediately and buffer its chunks. Nothing here emits
 * audio — ordering is the drain loop's job — so starting early cannot reorder
 * playout, it only removes the wait.
 */
function startSynthesis(item: PlayoutItem): StartedItem {
  const started: StartedItem = {
    text: item.text,
    controller: new AbortController(),
    chunks: [],
    done: false,
    failed: false,
    error: undefined,
    notify: null,
  };
  void (async () => {
    try {
      for await (const chunk of item.synthesize(started.controller.signal)) {
        started.chunks.push(chunk);
        wake(started);
      }
    } catch (err) {
      started.failed = true;
      started.error = err;
    } finally {
      started.done = true;
      wake(started);
    }
  })();
  return started;
}

function wake(item: StartedItem): void {
  const notify = item.notify;
  item.notify = null;
  notify?.();
}
