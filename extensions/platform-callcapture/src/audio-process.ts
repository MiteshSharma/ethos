// audio-process.ts — the piece `tap-capture.ts` and `mic-capture.ts` share:
// spawning a native helper that writes raw PCM bytes to stdout and
// NDJSON status lines to stderr, waiting for a binary-specific "ready" line
// before handing back a `PcmChunk` stream, and failing loud (never hanging)
// if that readiness signal never arrives.
//
// `detector.ts` was deliberately NOT folded into this — it parses a single
// NDJSON stream on stdout with no PCM and no readiness wait, a different
// enough shape that forcing it through this abstraction would cost more
// than it saves. What audiotee (Phase 3, other-participants stream) and
// mic-capture (Phase 3, mic stream) share instead is: two output streams
// (binary PCM + NDJSON status), a readiness gate, and byte-to-Int16Array
// framing — that's what lives here.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { PcmChunk } from '@ethosagent/types';

/**
 * The minimal shape a spawned native audio-capture process needs to expose.
 * Mirrors `detector.ts`'s `SpawnedChild` idiom, extended with a second
 * (stderr) stream since these binaries split status/metadata (stderr) from
 * raw audio bytes (stdout) — `detector.ts`'s binary puts everything on
 * stdout instead, so its `SpawnedChild` has no stderr field.
 */
export interface SpawnedAudioChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type AudioSpawnFn = (binaryPath: string, args: string[]) => SpawnedAudioChild;

/** Same injectable-timer idiom as `detector.ts`'s `Clock` — kept as a
 * separate declaration (not imported from detector.ts) so this module has
 * no dependency on detector.ts's internals; the shape is intentionally
 * identical. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Builds the real `AudioSpawnFn` used outside tests. `missingBinaryHint` is
 * baked in per caller (`tap-capture.ts` points at `build:audiotee`,
 * `mic-capture.ts` at `build:native`) so the "binary not found" error names
 * the right fix. The `existsSync` check lives here — not in
 * `startAudioCapture` — so injecting a fake `spawnFn` in tests bypasses it
 * entirely, the same convention `detector.ts`'s `defaultSpawn` uses.
 */
export function createDefaultAudioSpawn(missingBinaryHint: string): AudioSpawnFn {
  return (binaryPath, args) => {
    if (!existsSync(binaryPath)) {
      throw new Error(`audio-capture binary not found at ${binaryPath}. ${missingBinaryHint}`);
    }
    const child = nodeSpawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error('audio-capture child process was spawned without stdout/stderr pipes');
    }
    return {
      stdout,
      stderr,
      onExit: (listener) => {
        child.on('exit', listener);
      },
      onError: (listener) => {
        child.on('error', listener);
      },
      kill: (signal) => {
        child.kill(signal);
      },
    };
  };
}

/**
 * Parses raw PCM bytes arriving on `stdout` into `PcmChunk` frames. Bytes
 * can arrive split mid-sample across separate stream 'data' events (Node
 * makes no alignment guarantee), so a trailing odd byte is carried over to
 * the next chunk rather than dropped or corrupting the next frame.
 */
export async function* pcmChunksFromStdout(
  stdout: Readable,
  sampleRate: number,
): AsyncGenerator<PcmChunk> {
  let leftover: Buffer = Buffer.alloc(0);
  for await (const data of stdout) {
    const buf = leftover.length > 0 ? Buffer.concat([leftover, data as Buffer]) : (data as Buffer);
    const usableLen = buf.length - (buf.length % 2);
    leftover = buf.subarray(usableLen);
    if (usableLen === 0) continue;
    const frame = buf.subarray(0, usableLen);
    const int16 = new Int16Array(frame.length / 2);
    for (let i = 0; i < int16.length; i++) {
      int16[i] = frame.readInt16LE(i * 2);
    }
    yield { data: int16, sampleRate, timestampMs: Date.now() };
  }
}

export interface ReadyLineResult {
  /** Sample rate the binary reports it is actually emitting at. */
  sampleRate: number;
}

export interface StartAudioCaptureOptions {
  binaryPath: string;
  args: string[];
  spawnFn: AudioSpawnFn;
  clock: Clock;
  /** How long to wait for the readiness line before failing loud. */
  readinessTimeoutMs: number;
  /** How often (ms) to report waiting-progress while not yet ready. */
  heartbeatMs: number;
  /** Called once per heartbeat tick while waiting for readiness — the
   * "still waiting for the tap to start, Nth second" signal so a caller
   * never sees a silent hang. */
  onWaiting?: (secondsElapsed: number) => void;
  /** Inspects one parsed stderr JSON line; returns the readiness result if
   * this line signals "capture is live", else null. */
  isReadyLine: (fields: Record<string, unknown>) => ReadyLineResult | null;
  /** Inspects one parsed stderr JSON line; returns an error message if this
   * line signals a fatal error, else null. */
  isErrorLine: (fields: Record<string, unknown>) => string | null;
  /**
   * Surfaces a failure observed AFTER readiness (the process already
   * resolved a live `PcmChunk` stream, so there is no promise left to
   * reject) — a post-readiness error line, an unexpected exit, or a spawn
   * error. Never swallowed: the caller decides how to react, but this
   * module always calls it rather than letting the chunk stream just quietly
   * end as if `stop()` had been called.
   */
  onRuntimeError?: (message: string) => void;
}

export interface AudioCaptureHandle {
  sampleRate: number;
  chunks: AsyncIterable<PcmChunk>;
  /** Kills the underlying process. Safe to call more than once. */
  stop(): void;
}

/**
 * Spawns a native audio-capture binary, waits for its stderr readiness line
 * (or a fatal error line, or a timeout — whichever comes first), then hands
 * back a live `PcmChunk` stream over stdout. Never resolves into a silent
 * hang: a binary that never emits a readiness line fails loud after
 * `readinessTimeoutMs`, with `onWaiting` heartbeats surfaced along the way.
 */
export function startAudioCapture(options: StartAudioCaptureOptions): Promise<AudioCaptureHandle> {
  return new Promise((resolve, reject) => {
    // `options.spawnFn` throws synchronously for a missing binary in the
    // real implementation (`createDefaultAudioSpawn`); a throw inside this
    // executor becomes a rejection, so no separate existsSync check is
    // needed here — and none is run when a fake `spawnFn` is injected.
    const child = options.spawnFn(options.binaryPath, options.args);
    let settled = false;
    let stoppedByCaller = false;
    let heartbeatTimer: unknown = null;
    let timeoutTimer: unknown = null;
    let elapsedSeconds = 0;

    const clearTimers = (): void => {
      if (heartbeatTimer !== null) {
        options.clock.clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (timeoutTimer !== null) {
        options.clock.clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      stoppedByCaller = true;
      clearTimers();
      child.kill();
      reject(err);
    };

    const settleResolve = (sampleRate: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        sampleRate,
        chunks: pcmChunksFromStdout(child.stdout, sampleRate),
        stop: () => {
          stoppedByCaller = true;
          child.kill();
        },
      });
    };

    const scheduleHeartbeat = (): void => {
      heartbeatTimer = options.clock.setTimeout(() => {
        elapsedSeconds += Math.round(options.heartbeatMs / 1000);
        options.onWaiting?.(elapsedSeconds);
        if (!settled) scheduleHeartbeat();
      }, options.heartbeatMs);
    };

    timeoutTimer = options.clock.setTimeout(() => {
      settleReject(
        new Error(
          `audio-capture binary at ${options.binaryPath} did not report readiness within ${options.readinessTimeoutMs}ms`,
        ),
      );
    }, options.readinessTimeoutMs);
    if (options.heartbeatMs > 0) scheduleHeartbeat();

    const rl = createInterface({ input: child.stderr });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return; // non-JSON stderr noise; ignore rather than fail loud on it
      }
      if (typeof raw !== 'object' || raw === null) return;
      const fields = raw as Record<string, unknown>;

      const errorMessage = options.isErrorLine(fields);
      if (errorMessage !== null) {
        if (!settled) {
          settleReject(new Error(`audio-capture binary reported an error: ${errorMessage}`));
        } else {
          options.onRuntimeError?.(errorMessage);
        }
        return;
      }

      if (!settled) {
        const ready = options.isReadyLine(fields);
        if (ready !== null) settleResolve(ready.sampleRate);
      }
    });

    child.onError((err) => {
      if (!settled) {
        settleReject(new Error(`audio-capture process error: ${err.message}`));
      } else {
        options.onRuntimeError?.(`audio-capture process error: ${err.message}`);
      }
    });
    child.onExit((code, signal) => {
      if (!settled) {
        settleReject(
          new Error(
            `audio-capture process exited before reporting readiness (code=${code}, signal=${signal})`,
          ),
        );
        return;
      }
      // A clean stop() already killed the child before this fires — that
      // path doesn't call onRuntimeError. An exit we didn't request is a
      // real runtime failure and must be surfaced, not silently treated as
      // "the stream just ended".
      if (!stoppedByCaller) {
        options.onRuntimeError?.(
          `audio-capture process exited unexpectedly (code=${code}, signal=${signal})`,
        );
      }
    });
  });
}
