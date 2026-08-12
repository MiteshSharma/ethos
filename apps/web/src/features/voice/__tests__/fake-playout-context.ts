import type { PlayoutBuffer, PlayoutContext, PlayoutSource } from '../webaudio-playout';

/** A recording stand-in for `AudioContext` with a hand-cranked clock. */
export class FakePlayoutContext implements PlayoutContext {
  currentTime = 0;
  readonly destination = { id: 'destination' };
  /** Every source that was started, in schedule order. */
  readonly starts: Array<{ at: number; duration: number }> = [];
  readonly stopped: PlayoutSource[] = [];
  /** Resolvers for pending `decodeAudioData` calls, in call order. */
  private readonly decodes: Array<(buffer: PlayoutBuffer) => void> = [];

  createBuffer(_channels: number, frames: number, sampleRate: number): PlayoutBuffer {
    return { duration: frames / sampleRate };
  }

  fillMono(): void {}

  createBufferSource(): PlayoutSource {
    const starts = this.starts;
    const stopped = this.stopped;
    const source: PlayoutSource = {
      buffer: null,
      onended: null,
      connect: () => {},
      start(at: number) {
        starts.push({ at, duration: source.buffer?.duration ?? 0 });
      },
      stop() {
        stopped.push(source);
      },
    };
    return source;
  }

  decodeAudioData(): Promise<PlayoutBuffer> {
    return new Promise<PlayoutBuffer>((resolve) => this.decodes.push(resolve));
  }

  /** Resolve the Nth pending decode with a clip of `duration` seconds. */
  resolveDecode(index: number, duration: number): void {
    this.decodes[index]?.({ duration });
  }

  get pendingDecodes(): number {
    return this.decodes.length;
  }
}
