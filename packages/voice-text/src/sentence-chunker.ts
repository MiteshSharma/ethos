import { type SplitSentencesOptions, splitSentences } from './split-sentences';

/**
 * Streaming wrapper around {@link splitSentences}. Fed `text_delta` strings as
 * the model streams, it flushes complete sentences the moment a boundary is
 * seen and buffers the trailing partial for the next push.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly options: SplitSentencesOptions;

  constructor(options: SplitSentencesOptions = {}) {
    this.options = options;
  }

  /**
   * Append a streamed delta. Returns every sentence that became complete, in
   * order. Trailing partial text is retained for the next push or `flush()`.
   */
  push(delta: string): string[] {
    this.buffer += delta;
    const { sentences, rest } = splitSentences(this.buffer, this.options);
    this.buffer = rest;
    return sentences;
  }

  /** Emit any buffered remainder as a final sentence. Returns null if empty. */
  flush(): string | null {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder.length > 0 ? remainder : null;
  }
}
