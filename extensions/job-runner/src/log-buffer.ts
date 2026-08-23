// ---------------------------------------------------------------------------
// BoundedLogBuffer — the ring buffer behind `createLogSink` (I-LOG1).
//
// Split into its own module so the oldest-dropped-first eviction policy is
// directly unit-testable, independent of the batching timers/triggers that
// wrap it in `BackgroundExecutor`. In the executor's own default configuration
// the flush triggers (line-count, then time) almost always empty the buffer
// well before this cap is ever reached — the cap exists as a defensive bound
// against a future change to those constants, or a stalled flush, not as the
// normal path.
// ---------------------------------------------------------------------------

export interface RunnerLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * A FIFO of at most `maxLines` entries. Pushing past the cap drops the OLDEST
 * entry to make room for the newest — for a log tail, the freshest output is
 * the one worth keeping — and counts the drop so the next flush can say how
 * many lines were lost.
 */
export class BoundedLogBuffer {
  private lines: RunnerLogLine[] = [];
  private droppedCount = 0;

  constructor(private readonly maxLines: number) {}

  push(entry: RunnerLogLine): void {
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.droppedCount++;
    }
  }

  get length(): number {
    return this.lines.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Drains everything currently buffered and resets both the lines and the drop count. */
  drain(): { entries: RunnerLogLine[]; dropped: number } {
    const entries = this.lines;
    const dropped = this.droppedCount;
    this.lines = [];
    this.droppedCount = 0;
    return { entries, dropped };
  }
}
