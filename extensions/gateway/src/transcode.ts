import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type VoiceAudioFormat,
  voiceAudioExtension,
  voiceAudioFormatFromMime,
  voiceAudioMimeType,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// ffmpeg transcode stage for the gateway media path.
//
// Inbound audio is normalized before STT; outbound TTS audio is converted to
// whatever the target adapter declared in its voice caps. Every failure is a
// TYPED result — a channel that cannot transcode says so, it never sends
// silence or an empty transcript.
//
// Temp scratch files live in `os.tmpdir()`, not `~/.ethos/`, so the Storage
// abstraction does not apply (same carve-out as `command-tts`): ffmpeg needs
// real paths on a real filesystem.
// ---------------------------------------------------------------------------

/** What a transcode attempt produced, or why it produced nothing. */
export type TranscodeResult =
  | {
      ok: true;
      data: Uint8Array;
      format: VoiceAudioFormat;
      mimeType: string;
      /** False when the source was already in the target format and passed through. */
      transcoded: boolean;
      /** Set when the primary target failed and the fallback format was used. */
      fallbackFrom?: VoiceAudioFormat;
    }
  | { ok: false; code: TranscodeErrorCode; error: string };

export type TranscodeErrorCode = 'unavailable' | 'timeout' | 'failed';

type TranscodeFailure = Extract<TranscodeResult, { ok: false }>;

export interface TranscodeRequest {
  data: Uint8Array;
  /** Source mime, when the caller knows it. Only a filename hint — ffmpeg probes. */
  sourceMimeType?: string;
  /** Preferred target, then fallbacks in order. Must be non-empty. */
  targets: readonly VoiceAudioFormat[];
  /** Opus/mp3/aac bitrate in kbps. Default 32 — voice, not music. */
  bitrateKbps?: number;
  signal?: AbortSignal;
}

export interface Transcoder {
  /** True when ffmpeg is actually usable on this host (probed once, cached). */
  available(): Promise<boolean>;
  transcode(req: TranscodeRequest): Promise<TranscodeResult>;
}

export interface FfmpegTranscoderOptions {
  /** Path or name of the ffmpeg binary. Default `'ffmpeg'` (resolved on PATH). */
  ffmpegPath?: string;
  /** Per-invocation budget in ms. Default 30_000. */
  timeoutMs?: number;
  /** Injected process runner — the seam tests drive instead of a real ffmpeg. */
  run?: FfmpegRunner;
  /** Observability seam. Called once per attempt (success or failure). */
  onStage?: (event: TranscodeStageEvent) => void;
}

/** One ffmpeg invocation. Resolves with the exit code and stderr; never throws. */
export type FfmpegRunner = (
  args: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number | null; stderr: string; timedOut: boolean }>;

export interface TranscodeStageEvent {
  from: VoiceAudioFormat | 'unknown';
  to: VoiceAudioFormat;
  ok: boolean;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BITRATE_KBPS = 32;
/** Cap on the stderr we report back, tail-first — enough to see the real error. */
const MAX_ERROR_CHARS = 500;
/** Cap on what the default runner buffers from a chatty ffmpeg. */
const MAX_STDERR_BYTES = 64 * 1024;
const TEMP_PREFIX = 'ethos-transcode-';

/**
 * Encoder args per target format, everything between the input and the output
 * path. A `Record` over the union on purpose: a new {@link VoiceAudioFormat} is
 * a compile error until it is handled here.
 *
 * `null` means "stock ffmpeg cannot produce this" — see `silk`.
 */
const ENCODER_ARGS: Record<VoiceAudioFormat, (bitrateKbps: number) => string[] | null> = {
  opus: (b) => ['-c:a', 'libopus', '-b:a', `${b}k`, '-ac', '1', '-ar', '48000', '-f', 'ogg'],
  ogg: (b) => ['-c:a', 'libopus', '-b:a', `${b}k`, '-ac', '1', '-ar', '48000', '-f', 'ogg'],
  mp3: (b) => ['-c:a', 'libmp3lame', '-b:a', `${b}k`, '-ac', '1', '-f', 'mp3'],
  wav: () => ['-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav'],
  m4a: (b) => ['-c:a', 'aac', '-b:a', `${b}k`, '-ac', '1', '-f', 'ipod'],
  aac: (b) => ['-c:a', 'aac', '-b:a', `${b}k`, '-ac', '1', '-f', 'adts'],
  amr: () => ['-c:a', 'libopencore_amrnb', '-b:a', '12.2k', '-ac', '1', '-ar', '8000', '-f', 'amr'],
  flac: () => ['-c:a', 'flac', '-ac', '1', '-f', 'flac'],
  webm: (b) => ['-c:a', 'libopus', '-b:a', `${b}k`, '-ac', '1', '-f', 'webm'],
  pcm: () => ['-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 's16le'],
  // Stock ffmpeg has no SILK encoder. Kept in the map (rather than dropped from
  // the union) so the caps model stays expressive for LINE/WeChat adapters —
  // but we fail honestly instead of shipping a mislabelled container.
  silk: () => null,
};

const SILK_UNSUPPORTED =
  'silk requires a platform-specific encoder; stock ffmpeg cannot produce it';

/**
 * True when bytes already in `source` can be sent as `target` untouched.
 *
 * `opus` and `ogg` name the same container, so opus bytes satisfy an `ogg`
 * target. NOT the reverse: a `.ogg` holding vorbis is not an opus voice note,
 * and a platform asking for `opus` means the codec, not the container.
 */
function satisfies(source: VoiceAudioFormat | undefined, target: VoiceAudioFormat): boolean {
  if (source === undefined) return false;
  if (source === target) return true;
  return source === 'opus' && target === 'ogg';
}

/** Tail of ffmpeg's stderr, trimmed to something a channel can surface. */
function errorTail(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_ERROR_CHARS ? trimmed.slice(-MAX_ERROR_CHARS) : trimmed;
}

function tempPath(extension: string): string {
  return join(tmpdir(), `${TEMP_PREFIX}${randomBytes(8).toString('hex')}.${extension}`);
}

/**
 * Default runner: `spawn` with the timeout enforced by an `AbortController`.
 * Never throws — a missing binary resolves as `{ code: null }` so the caller
 * reports `unavailable` rather than crashing the media path.
 */
function createSpawnRunner(ffmpegPath: string): FfmpegRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      const controller = new AbortController();
      let timedOut = false;
      let settled = false;
      const chunks: string[] = [];
      let stderrBytes = 0;

      const onExternalAbort = () => controller.abort();
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.timeoutMs);

      const finish = (code: number | null, stderr: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onExternalAbort);
        resolve({ code, stderr, timedOut });
      };

      const child = spawn(ffmpegPath, [...args], {
        signal: controller.signal,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        stderrBytes += chunk.length;
        chunks.push(chunk.toString('utf8'));
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          finish(null, `ffmpeg not found at '${ffmpegPath}'`);
          return;
        }
        finish(null, chunks.join('') || err.message);
      });

      child.on('close', (code) => finish(code, chunks.join('')));
    });
}

export function createFfmpegTranscoder(opts: FfmpegTranscoderOptions = {}): Transcoder {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.run ?? createSpawnRunner(ffmpegPath);
  const onStage = opts.onStage;
  let probe: Promise<boolean> | undefined;

  const report = (event: TranscodeStageEvent): void => {
    if (!onStage) return;
    try {
      onStage(event);
    } catch {
      // Observability must never break the media path.
    }
  };

  const available = (): Promise<boolean> => {
    // Cache the PROMISE, not the boolean: concurrent callers probe once.
    probe ??= run(['-version'], { timeoutMs }).then((r) => r.code === 0);
    return probe;
  };

  /** One ffmpeg invocation against one target. Cleans up its own output file. */
  async function attempt(
    req: TranscodeRequest,
    from: VoiceAudioFormat | 'unknown',
    target: VoiceAudioFormat,
    inputPath: string,
    bitrateKbps: number,
  ): Promise<TranscodeResult> {
    const started = Date.now();
    const fail = (code: TranscodeErrorCode, error: string): TranscodeResult => {
      report({
        from,
        to: target,
        ok: false,
        bytesIn: req.data.length,
        bytesOut: 0,
        durationMs: Date.now() - started,
        error,
      });
      return { ok: false, code, error };
    };

    const encoder = ENCODER_ARGS[target](bitrateKbps);
    if (encoder === null) return fail('failed', SILK_UNSUPPORTED);

    const outputPath = tempPath(voiceAudioExtension(target));
    try {
      const runOpts = req.signal ? { timeoutMs, signal: req.signal } : { timeoutMs };
      const result = await run(
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, ...encoder, outputPath],
        runOpts,
      );
      if (result.timedOut) {
        return fail('timeout', `ffmpeg timed out after ${timeoutMs}ms converting to ${target}`);
      }
      if (result.code !== 0) {
        return fail(
          'failed',
          errorTail(
            result.stderr,
            `ffmpeg exited with code ${result.code} converting to ${target}`,
          ),
        );
      }

      const output = await readFile(outputPath).catch(() => undefined);
      if (!output || output.length === 0) {
        return fail(
          'failed',
          errorTail(result.stderr, `ffmpeg produced no output converting to ${target}`),
        );
      }

      report({
        from,
        to: target,
        ok: true,
        bytesIn: req.data.length,
        bytesOut: output.length,
        durationMs: Date.now() - started,
      });
      return {
        ok: true,
        data: new Uint8Array(output),
        format: target,
        mimeType: voiceAudioMimeType(target),
        transcoded: true,
      };
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }

  async function transcode(req: TranscodeRequest): Promise<TranscodeResult> {
    const primary = req.targets[0];
    if (primary === undefined) {
      return { ok: false, code: 'failed', error: 'transcode requires at least one target format' };
    }

    const source = voiceAudioFormatFromMime(req.sourceMimeType);

    // Pass-through is checked BEFORE availability: bytes already in the target
    // format need no ffmpeg, so a host without ffmpeg still serves this path.
    if (satisfies(source, primary)) {
      return {
        ok: true,
        data: req.data,
        format: primary,
        mimeType: voiceAudioMimeType(primary),
        transcoded: false,
      };
    }

    if (!(await available())) {
      return {
        ok: false,
        code: 'unavailable',
        error: `ffmpeg is not available (tried '${ffmpegPath}') — cannot convert to ${primary}`,
      };
    }

    const from = source ?? 'unknown';
    const bitrateKbps = req.bitrateKbps ?? DEFAULT_BITRATE_KBPS;
    const inputPath = tempPath(source ? voiceAudioExtension(source) : 'bin');
    await writeFile(inputPath, req.data);
    try {
      // Every failure code retries down the list, not just "bad request" ones:
      // a missing encoder, a timeout and a malformed container all mean the
      // same thing to the caller — this target did not work, try the next.
      let last: TranscodeFailure = {
        ok: false,
        code: 'failed',
        error: 'no transcode target was attempted',
      };
      for (const target of req.targets) {
        const result = await attempt(req, from, target, inputPath, bitrateKbps);
        if (result.ok) {
          return target === primary ? result : { ...result, fallbackFrom: primary };
        }
        last = result;
      }
      // The LAST attempt's failure is the reported one — it is the most recent
      // thing the host actually told us.
      return last;
    } finally {
      await unlink(inputPath).catch(() => {});
    }
  }

  return { available, transcode };
}
