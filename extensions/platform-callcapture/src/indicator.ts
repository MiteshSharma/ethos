// CaptureIndicator — Node wrapper around the compiled `capture-indicator`
// Swift binary (native/capture-indicator.swift): the floating on-screen
// badge (plan/phases/call-capture-desktop-ux.md) shown while `ethos serve`/
// `ethos gateway`'s headless `CallCaptureDaemon` has a capture in flight.
// This is the CLI-daemon analog of the desktop app's Electron-based
// `apps/desktop/src/main/call-capture-pill.ts` — that surface already has a
// `BrowserWindow` available; a bare Node CLI process does not, so this is a
// real native AppKit process instead.
//
// Structurally satisfies `daemon.ts`'s `CallCaptureIndicatorPort`
// (show/updateTranscript/hide/onEndRequested) WITHOUT importing it — the
// same import-direction discipline `detector.ts`/`notification.ts` already
// follow (the port interfaces live in daemon.ts; the concrete
// implementations never import daemon.ts back).
//
// PROCESS LIFECYCLE — one process spawned per capture: `show()` spawns
// (passing the source label as `argv[1]` — see `capture-indicator.swift`'s
// header comment, "SOURCE ARG + 'WAITING' PLACEHOLDER"), `hide()` tells it
// to close its window and exit. This mirrors the "process per session"
// lifecycle `mic-capture.ts`/`tap-capture.ts` already use for the audio
// helpers, rather than one long-lived indicator process reused across
// calls.
//
// Outbound (Node -> Swift), one NDJSON command per line on stdin:
//   {"command":"transcript_append","speaker":"you"|"other","text":"..."}
//   {"command":"audio_level","speaker":"you"|"other","level":<number>}
//   {"command":"hide"}
// Inbound (Swift -> Node), one NDJSON event per line on stdout:
//   {"event":"ready"}                  — window created and shown
//   {"event":"end_requested"}          — the popover's "End" button was clicked
//   {"event":"error","message":"..."}  — non-fatal problem worth logging
//
// Best-effort throughout: a failure to spawn, write, or the process exiting
// unexpectedly is surfaced via `onError` (logging only) and never throws —
// the indicator is visual feedback, not a dependency the capture pipeline
// needs to function. It is therefore deliberately NOT part of
// `checkCallCaptureDependencies`'s preflight gate.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Speaker, TranscriptEntry } from './transcript-session';

/**
 * The minimal shape `CaptureIndicator` needs from a spawned child process.
 * Mirrors `detector.ts`'s `SpawnedChild` idiom, extended with a `stdin`
 * writable since this is the first native helper in this package that reads
 * commands INBOUND rather than only ever writing outbound.
 */
export interface SpawnedIndicatorChild {
  readonly stdout: Readable;
  readonly stdin: Writable;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type IndicatorSpawnFn = (binaryPath: string, args: string[]) => SpawnedIndicatorChild;

function defaultBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'capture-indicator');
}

const BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';

function defaultSpawn(binaryPath: string, args: string[]): SpawnedIndicatorChild {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `capture-indicator binary not found at ${binaryPath}. Build it with: ${BUILD_COMMAND}`,
    );
  }
  const child = nodeSpawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    throw new Error('capture-indicator child process was spawned without stdin/stdout pipes');
  }
  return {
    stdout,
    stdin,
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

export interface CaptureIndicatorOptions {
  /** Overrides the compiled binary path. Defaults to
   * `native/bin/capture-indicator` next to this package. */
  binaryPath?: string;
  /** Overrides how the native binary is spawned. Tests must supply this — a
   * fake — instead of touching a real process or the compiled binary. */
  spawnFn?: IndicatorSpawnFn;
  /** Surfaces a spawn/write/runtime failure — best-effort logging only;
   * never thrown, and never blocks or fails the capture pipeline. */
  onError?: (message: string) => void;
}

/**
 * The CLI-daemon floating indicator. Structurally satisfies `daemon.ts`'s
 * `CallCaptureIndicatorPort`.
 */
export class CaptureIndicator {
  private readonly binaryPath: string;
  private readonly spawnFn: IndicatorSpawnFn;
  private readonly onError: ((message: string) => void) | undefined;

  private child: SpawnedIndicatorChild | null = null;
  private endRequestedCallback: (() => void) | null = null;

  constructor(options: CaptureIndicatorOptions = {}) {
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.onError = options.onError;
  }

  /** Registered once by the daemon in `start()`; forwards every future
   * "End" button click — across however many show()/hide() cycles this
   * indicator goes through — to the same callback. */
  onEndRequested(callback: () => void): void {
    this.endRequestedCallback = callback;
  }

  show(source: string): void {
    // Defensive guard: the daemon only calls show() once per accepted call
    // (mirrors handleCallStarted's own "shouldn't happen, guard anyway"
    // posture) — don't double-spawn if it somehow does.
    if (this.child) return;
    let child: SpawnedIndicatorChild;
    try {
      child = this.spawnFn(this.binaryPath, [source]);
    } catch (err) {
      this.onError?.(
        `capture-indicator failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    child.onError((err) => {
      this.onError?.(`capture-indicator process error: ${err.message}`);
    });
    child.onExit((code, signal) => {
      // hide() already cleared this.child before killing/asking it to exit
      // — an exit event arriving after that is the expected clean shutdown.
      if (this.child !== child) return;
      this.child = null;
      if (code !== 0) {
        this.onError?.(
          `capture-indicator process exited unexpectedly (code=${code}, signal=${signal})`,
        );
      }
    });
  }

  updateTranscript(entry: TranscriptEntry): void {
    this.writeCommand({ command: 'transcript_append', speaker: entry.speaker, text: entry.text });
  }

  /** Forwards one live audio-level reading to the native level-meter. `at`
   * (a wall-clock timestamp) is not part of the wire command — the native
   * side only needs the current value to render, not when it was sampled. */
  updateAudioLevel(speaker: Speaker, level: number, _at: number): void {
    this.writeCommand({ command: 'audio_level', speaker, level });
  }

  hide(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin.write(`${JSON.stringify({ command: 'hide' })}\n`);
    } catch {
      // best-effort — the kill() below still tears it down.
    }
    // Backstop, not a race: even if the write above failed or the process
    // is slow to react, this always leaves no orphaned window behind. A
    // process that already exited on its own treats this as a safe no-op.
    child.kill();
  }

  private writeCommand(command: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (err) {
      this.onError?.(
        `capture-indicator write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise; ignore rather than fail loud
    }
    if (typeof raw !== 'object' || raw === null) return;
    const fields = raw as Record<string, unknown>;
    if (fields.event === 'end_requested') {
      this.endRequestedCallback?.();
      return;
    }
    if (fields.event === 'error' && typeof fields.message === 'string') {
      this.onError?.(`capture-indicator reported an error: ${fields.message}`);
    }
    // 'ready' and any other/unknown event: no-op. 'ready' has no consumer
    // yet — show() doesn't block on it, since a slow-to-launch window is
    // still strictly better than treating a missing indicator as fatal.
  }
}
