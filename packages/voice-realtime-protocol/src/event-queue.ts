import type { RealtimeEvent } from '@ethosagent/types';

/**
 * A single-consumer push queue behind an `AsyncIterable<RealtimeEvent>`.
 *
 * A realtime session produces events from a socket callback and the caller
 * consumes them with `for await`. Nothing in the standard library bridges those
 * two shapes without either dropping events (an EventTarget the caller
 * subscribes to late) or blocking the socket thread (a generator that awaits a
 * consumer). This buffers instead: `push` never blocks, `end` completes the
 * iterator, and events pushed before anyone iterates are still delivered.
 */
export class RealtimeEventQueue implements AsyncIterable<RealtimeEvent> {
  private readonly buffered: RealtimeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RealtimeEvent>) => void> = [];
  private ended = false;

  push(event: RealtimeEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffered.push(event);
  }

  /** Complete the iterator. Already-buffered events are still drained first. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    return {
      next: (): Promise<IteratorResult<RealtimeEvent>> => {
        const buffered = this.buffered.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
