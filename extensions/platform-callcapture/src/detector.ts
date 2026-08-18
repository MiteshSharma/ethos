// MicActivityDetector — Node wrapper around the compiled `mic-detector`
// Swift binary (native/mic-detector.swift). Translates its raw
// initial/running_changed/error NDJSON events into the public
// call_started/call_ended/error contract, with `call_ended` debounced so a
// sub-second mic hand-off between apps isn't reported as a call ending.
//
// Phase 1 scope only (plan/phases/call-capture-extension.md) — detection,
// nothing else. See README.md.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export type MicActivityEvent =
  | { type: 'call_started'; at: number }
  | { type: 'call_ended'; at: number }
  | { type: 'error'; message: string };

/**
 * The minimal shape `MicActivityDetector` needs from a spawned child
 * process. Real `node:child_process.spawn()` output satisfies this
 * structurally (via `defaultSpawn`'s thin wrapper below); tests inject a
 * fake that doesn't touch a real process. One method per event, mirroring
 * the `onCaption` idiom in `@ethosagent/platform-meeting`'s `MeetingClient`,
 * rather than an overloaded `on()` — simpler to implement in a fake and to
 * type without casts.
 */
export interface SpawnedChild {
  readonly stdout: Readable;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (binaryPath: string) => SpawnedChild;

/**
 * Injectable timer pair so the debounce is testable without real delays.
 * `handle` is opaque on purpose — callers only ever round-trip whatever
 * `setTimeout` returned back into `clearTimeout`, never inspect it, so a
 * fake clock can hand back a plain number instead of a real `Timeout`.
 */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

/** Default debounce window for `call_ended`: mic state can flicker for
 * sub-second gaps as apps hand the device off; don't report "ended" on
 * every flicker. `call_started` is never debounced. */
const DEFAULT_DEBOUNCE_MS = 2000;

function defaultBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'mic-detector');
}

const BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';

function defaultSpawn(binaryPath: string): SpawnedChild {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `mic-detector binary not found at ${binaryPath}. Build it with: ${BUILD_COMMAND}`,
    );
  }
  const child = nodeSpawn(binaryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error('mic-detector child process was spawned without a stdout pipe');
  }
  return {
    stdout,
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
}

export interface MicActivityDetectorOptions {
  /** Overrides how the native binary is spawned. Tests must supply this — a
   * fake — instead of touching a real process or the compiled binary. */
  spawnFn?: SpawnFn;
  /** Overrides the compiled binary path. Defaults to
   * `native/bin/mic-detector` next to this package. */
  binaryPath?: string;
  /** `call_ended` debounce window in ms. Defaults to 2000. */
  debounceMs?: number;
  /** Overrides the timer implementation used for the debounce. */
  clock?: Clock;
}

/**
 * Detects "a call is happening" by watching whether the default microphone
 * is in use, via the compiled `mic-detector` CoreAudio helper. macOS only.
 */
export class MicActivityDetector {
  private readonly spawnFn: SpawnFn;
  private readonly binaryPath: string;
  private readonly debounceMs: number;
  private readonly clock: Clock;

  private child: SpawnedChild | null = null;
  private onEvent: ((event: MicActivityEvent) => void) | null = null;
  private endTimer: unknown = null;
  private inCall = false;

  constructor(options: MicActivityDetectorOptions = {}) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.clock = options.clock ?? realClock;
  }

  start(onEvent: (event: MicActivityEvent) => void): void {
    if (process.platform !== 'darwin') {
      throw new Error(
        `MicActivityDetector only supports macOS (CoreAudio); process.platform is "${process.platform}"`,
      );
    }
    if (this.child) {
      throw new Error(
        'MicActivityDetector.start() called while already running — call stop() first',
      );
    }

    const child = this.spawnFn(this.binaryPath);
    this.child = child;
    this.onEvent = onEvent;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    child.onError((err) => {
      this.emit({ type: 'error', message: `mic-detector process error: ${err.message}` });
    });
    child.onExit((code, signal) => {
      // A clean shutdown clears this.child in stop() before killing the
      // child, so an exit event arriving after that is expected and silent.
      if (this.child !== child) return;
      this.child = null;
      this.emit({
        type: 'error',
        message: `mic-detector process exited unexpectedly (code=${code}, signal=${signal})`,
      });
    });
  }

  stop(): void {
    if (this.endTimer !== null) {
      this.clock.clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.onEvent = null;
    child?.kill();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.emit({ type: 'error', message: `mic-detector emitted an unparseable line: ${trimmed}` });
      return;
    }
    if (typeof raw !== 'object' || raw === null) {
      this.emit({ type: 'error', message: `mic-detector emitted a non-object line: ${trimmed}` });
      return;
    }

    const fields = raw as Record<string, unknown>;
    switch (fields.event) {
      case 'initial':
      case 'running_changed':
        if (typeof fields.running !== 'boolean') {
          this.emit({
            type: 'error',
            message: `mic-detector "${fields.event}" event is missing a boolean "running": ${trimmed}`,
          });
          return;
        }
        this.handleRunningChanged(fields.running);
        return;
      case 'error':
        this.emit({
          type: 'error',
          message:
            typeof fields.message === 'string'
              ? fields.message
              : `mic-detector reported an error: ${trimmed}`,
        });
        return;
      default:
        this.emit({
          type: 'error',
          message: `mic-detector emitted an unrecognized event: ${trimmed}`,
        });
    }
  }

  private handleRunningChanged(running: boolean): void {
    if (running) {
      // A running=true arriving while an end-debounce is pending is exactly
      // the flicker case: cancel the pending end, we're still in the call.
      if (this.endTimer !== null) {
        this.clock.clearTimeout(this.endTimer);
        this.endTimer = null;
      }
      if (!this.inCall) {
        this.inCall = true;
        this.emit({ type: 'call_started', at: Date.now() });
      }
      return;
    }

    if (!this.inCall || this.endTimer !== null) return;
    this.endTimer = this.clock.setTimeout(() => {
      this.endTimer = null;
      this.inCall = false;
      this.emit({ type: 'call_ended', at: Date.now() });
    }, this.debounceMs);
  }

  private emit(event: MicActivityEvent): void {
    this.onEvent?.(event);
  }
}
