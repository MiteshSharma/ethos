// MicCapture — the MIC-input half of Phase 3's dual-stream audio capture
// (plan/phases/call-capture-extension.md decision 2 + "Phase 3"). Wraps the
// compiled `mic-capture` Swift binary (native/mic-capture.swift), which
// captures the user's own voice via `AVAudioEngine.inputNode` — a
// completely different signal path from `tap-capture.ts`'s system-output
// capture, since the user's own voice never goes out over system audio.
//
// Mirrors `tap-capture.ts`'s shape closely (both are thin wrappers over
// `audio-process.ts`'s `startAudioCapture`) but with its own stderr
// message-shape parsing, since `mic-capture.swift`'s JSON lines are a loose
// mirror of audiotee's shape, not identical to it — see
// native/mic-capture.swift's header comment.

import { join } from 'node:path';
import type { PcmChunk } from '@ethosagent/types';
import type { AudioCaptureHandle, AudioSpawnFn, Clock, ReadyLineResult } from './audio-process';
import { createDefaultAudioSpawn, realClock, startAudioCapture } from './audio-process';

/** The mic path has not shown the cold-start anomaly `tap-capture.ts`
 * documents for audiotee (own empirical check: back-to-back runs both
 * produced steady output within a couple hundred ms) — but a single manual
 * check isn't proof it can never happen, so this stays generous rather than
 * tight. See README.md "Phase 3" for the actual observation. */
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

function defaultBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'mic-capture');
}

const BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';

/** `mic-capture.swift`'s readiness signal: its own `metadata` line, emitted
 * once before the tap is installed. Parsed rather than assumed, same
 * rationale as `tap-capture.ts`. */
function isReadyLine(fields: Record<string, unknown>): ReadyLineResult | null {
  if (fields.message_type !== 'metadata') return null;
  const data = fields.data;
  if (typeof data !== 'object' || data === null) return null;
  const sampleRate = (data as Record<string, unknown>).sample_rate;
  if (typeof sampleRate !== 'number') return null;
  return { sampleRate };
}

function isErrorLine(fields: Record<string, unknown>): string | null {
  if (fields.message_type !== 'error') return null;
  const data = fields.data;
  if (typeof data === 'object' && data !== null) {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'mic-capture reported an error with no message field';
}

export interface MicCaptureOptions {
  /** Overrides the compiled binary path. Defaults to
   * `native/bin/mic-capture` next to this package. */
  binaryPath?: string;
  /** Overrides how the native binary is spawned. Tests must supply this — a
   * fake — instead of touching a real process or the compiled binary. */
  spawnFn?: AudioSpawnFn;
  /** Overrides the timer implementation used for the readiness timeout and
   * heartbeat. */
  clock?: Clock;
  /** How long to wait for the readiness (`metadata`) line before failing
   * loud. Defaults to 20s. */
  readinessTimeoutMs?: number;
  /** How often (ms) to report waiting-progress while not yet ready. Set to
   * 0 to disable. Defaults to 5000. */
  heartbeatMs?: number;
  /** Called once per heartbeat tick while waiting for readiness. */
  onWaiting?: (secondsElapsed: number) => void;
  /** Surfaces a failure observed after capture already started. */
  onRuntimeError?: (message: string) => void;
}

/**
 * Captures the user's own mic input via the compiled `mic-capture` binary.
 * macOS only (AVAudioEngine).
 */
export class MicCapture {
  private readonly binaryPath: string;
  private readonly spawnFn: AudioSpawnFn;
  private readonly clock: Clock;
  private readonly readinessTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly onWaiting: ((secondsElapsed: number) => void) | undefined;
  private readonly onRuntimeError: ((message: string) => void) | undefined;

  private handle: AudioCaptureHandle | null = null;

  constructor(options: MicCaptureOptions = {}) {
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
    this.spawnFn = options.spawnFn ?? createDefaultAudioSpawn(`Build it with: ${BUILD_COMMAND}`);
    this.clock = options.clock ?? realClock;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onWaiting = options.onWaiting;
    this.onRuntimeError = options.onRuntimeError;
  }

  /**
   * Starts mic-capture and resolves once it reports readiness (or rejects on
   * a fatal error line, an unexpected exit, or the readiness timeout).
   * Resolves an `AsyncIterable<PcmChunk>` over the mic's output.
   */
  async start(): Promise<AsyncIterable<PcmChunk>> {
    if (process.platform !== 'darwin') {
      throw new Error(
        `MicCapture only supports macOS (AVAudioEngine); process.platform is "${process.platform}"`,
      );
    }
    if (this.handle) {
      throw new Error('MicCapture.start() called while already running — call stop() first');
    }
    const handle = await startAudioCapture({
      binaryPath: this.binaryPath,
      args: [],
      spawnFn: this.spawnFn,
      clock: this.clock,
      readinessTimeoutMs: this.readinessTimeoutMs,
      heartbeatMs: this.heartbeatMs,
      onWaiting: this.onWaiting,
      isReadyLine,
      isErrorLine,
      onRuntimeError: this.onRuntimeError,
    });
    this.handle = handle;
    return handle.chunks;
  }

  stop(): void {
    this.handle?.stop();
    this.handle = null;
  }
}
