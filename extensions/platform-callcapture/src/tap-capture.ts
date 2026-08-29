// TapCapture — the OTHER-PARTICIPANTS half of Phase 3's dual-stream audio
// capture (plan/phases/call-capture-extension.md decision 2 + "Phase 3 —
// Audio capture spike, standalone"). Wraps the vendored `audiotee` binary
// (Core Audio Process Tap capture of system output audio), pinned at commit
// 56ac954369a09318e46b88a6eec33c2d2b0d32a3 — see README.md "Phase 3" for why
// it's fetched-by-script rather than vendored into git, and for the observed
// cold-start latency this module's readiness wait exists to characterize.
//
// Footgun #1 from decision 2 ("AVAudioEngine cannot be retargeted to a
// tap-backed aggregate device") is moot here by design: this module never
// touches AVAudioEngine for the tap stream at all — audiotee owns the Core
// Audio Process Tap calls entirely, as an external process. See README.md
// "Phase 3" for the full footgun-tracking table.

import { join } from 'node:path';
import type { PcmChunk } from '@ethosagent/types';
import type { AudioCaptureHandle, AudioSpawnFn, Clock, ReadyLineResult } from './audio-process';
import { createDefaultAudioSpawn, realClock, startAudioCapture } from './audio-process';

const DEFAULT_SAMPLE_RATE = 16_000;
/** Generous per decision 2's observed cold-start anomaly: a first-run tap
 * has been seen to take ~13s between "Creating IO proc" and real audio
 * flowing, vs. under 100ms on a warm run. 20s leaves headroom without
 * hanging forever on a genuinely stuck tap. */
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

function defaultBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'vendor', 'audiotee', 'audiotee');
}

const FETCH_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:audiotee';

/** audiotee's stderr NDJSON `message_type` values this module cares about.
 * `metadata` is the readiness signal (see README.md "Phase 3") — it carries
 * the actual emitted format, parsed rather than assumed, in case a future
 * audiotee version or flag combination changes it. */
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
  return 'audiotee reported an error with no message field';
}

export interface TapCaptureOptions {
  /** Overrides the vendored binary path. Defaults to
   * `native/vendor/audiotee/audiotee` next to this package. */
  binaryPath?: string;
  /** Target sample rate passed as `--sample-rate`. Defaults to 16000, which
   * is what `@ethosagent/types`' `PcmChunk`/STT pipeline expects. */
  sampleRate?: number;
  /** Overrides how the native binary is spawned. Tests must supply this — a
   * fake — instead of touching a real process or the compiled binary. */
  spawnFn?: AudioSpawnFn;
  /** Overrides the timer implementation used for the readiness timeout and
   * heartbeat. */
  clock?: Clock;
  /** How long to wait for audiotee's readiness (`metadata`) line before
   * failing loud. Defaults to 20s — see the cold-start note above. */
  readinessTimeoutMs?: number;
  /** How often (ms) to report waiting-progress while not yet ready. Set to
   * 0 to disable. Defaults to 5000. */
  heartbeatMs?: number;
  /** Called once per heartbeat tick while waiting for readiness — surfaces
   * "still waiting for the tap to start, Nth second" instead of a silent
   * hang. */
  onWaiting?: (secondsElapsed: number) => void;
  /** Surfaces a failure observed after capture already started (a
   * post-readiness error line, or an unexpected process exit). */
  onRuntimeError?: (message: string) => void;
}

/**
 * Captures system output audio (other call participants) via the vendored
 * `audiotee` binary. macOS 14.2+ only (Core Audio Process Tap API).
 */
export class TapCapture {
  private readonly binaryPath: string;
  private readonly sampleRate: number;
  private readonly spawnFn: AudioSpawnFn;
  private readonly clock: Clock;
  private readonly readinessTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly onWaiting: ((secondsElapsed: number) => void) | undefined;
  private readonly onRuntimeError: ((message: string) => void) | undefined;

  private handle: AudioCaptureHandle | null = null;

  constructor(options: TapCaptureOptions = {}) {
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.spawnFn = options.spawnFn ?? createDefaultAudioSpawn(`Build it with: ${FETCH_COMMAND}`);
    this.clock = options.clock ?? realClock;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onWaiting = options.onWaiting;
    this.onRuntimeError = options.onRuntimeError;
  }

  /**
   * Starts audiotee and resolves once it reports readiness (or rejects on a
   * fatal error line, an unexpected exit, or the readiness timeout — never
   * hangs silently). Resolves an `AsyncIterable<PcmChunk>` over the tap's
   * output.
   */
  async start(): Promise<AsyncIterable<PcmChunk>> {
    if (process.platform !== 'darwin') {
      throw new Error(
        `TapCapture only supports macOS (Core Audio Process Tap); process.platform is "${process.platform}"`,
      );
    }
    if (this.handle) {
      throw new Error('TapCapture.start() called while already running — call stop() first');
    }
    const handle = await startAudioCapture({
      binaryPath: this.binaryPath,
      args: ['--sample-rate', String(this.sampleRate)],
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
