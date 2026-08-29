// @ethosagent/tools-callcapture — the call-capture pipeline
// (plan/phases/call-capture-extension.md, Phase 4 integration / T11).
//
// Wires Phase 1-3's local dual-stream capture (`@ethosagent/platform-callcapture`'s
// `TapCapture`/`MicCapture` + `runTranscriptSession`) into `runCallCapture()`:
// start both capture streams, transcribe until the caller's `abortSignal`
// fires (the same "transcribe until stopped" lifecycle `meet_join` uses),
// then summarize, write the transcript+summary artifact to memory, and
// append a compact digest-index entry (decision 8). Optionally mirrors the
// per-call artifact (never the digest index) into the personality's
// `fs_reach.workdir` so it surfaces in the web app's Documents tab
// (plan/phases/call-capture-desktop-ux.md, P4) — see `documentsWorkdir`/
// `storage` on `CallCaptureToolsOptions`.
//
// DISPATCH: this is a plain function, not a registered `Tool` — it is never
// LLM-callable. `requiresApproval: true` on a `Tool` is announcement-only in
// this codebase (`packages/core/src/agent-loop/stages/tool-processing.ts`'s
// own comment confirms it, not a gate), so the only real accept gate is the
// macOS OS-notification click handled by `extensions/platform-callcapture/
// src/daemon.ts`'s `CallCaptureDaemon`, which calls `runCallCapture()`
// directly and deterministically once a click is accepted — see
// `packages/wiring/src/build-agent-loop.ts` for the binding.
//
// UNTRUSTED OUTPUT: the same INB-003 laundering risk `meet_join`'s
// transcript write had — unauthenticated call-participant speech about to
// land in the framework's default-TRUSTED memory store. Explicit
// `wrapUntrusted()` around "Other participant" content (and the summary)
// before it is persisted — see artifact.ts for the "You" vs "Other
// participant" wrapping judgment call.

import { join } from 'node:path';
import type { Speaker, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { computeRmsLevel, runTranscriptSession } from '@ethosagent/platform-callcapture';
import type {
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  PcmChunk,
  Storage,
  SttProvider,
} from '@ethosagent/types';
import {
  buildCallCaptureArtifact,
  buildDigestLine,
  buildTranscriptBody,
  sanitizeSource,
} from './artifact';
import { summarizeTranscript } from './summarize';

const CALL_CAPTURES_INDEX_KEY = 'call-captures-index.md';

/**
 * The minimal shape `runCallCapture` needs from a capture stream.
 * `TapCapture`/`MicCapture` (`@ethosagent/platform-callcapture`) satisfy
 * this structurally — no adapter needed. Declared narrowly here, mirroring
 * `tools-meeting`'s `MeetingClient` boundary pattern, so tests inject a fake
 * stream instead of touching real audio hardware.
 */
export interface CaptureBoundary {
  start(): Promise<AsyncIterable<PcmChunk>>;
  stop(): void;
}

export interface CallCaptureToolsOptions {
  /**
   * Captures other participants' audio (system output tap). Optional:
   * default installs wire none, so `runCallCapture` reports itself
   * unavailable until configured.
   */
  tapCapture?: CaptureBoundary;
  /** Captures the operator's own mic input. */
  micCapture?: CaptureBoundary;
  /** STT provider driving both streams — independent passes per decision 7 (never pre-mixed). */
  sttProvider?: SttProvider;
  /** Store the transcript+summary artifact and the digest index are written to. */
  memory?: MemoryProvider;
  /**
   * Storage backend for the Documents-tab mirror (plan/phases/
   * call-capture-desktop-ux.md, P4). Paired with `documentsWorkdir` below —
   * both must be present for the mirror write to happen; either absent
   * skips it silently (the general case for any personality with no
   * `fs_reach.workdir` configured). Never used for the memory-scope write
   * above, which always goes through `memory`. Callers MUST pass a Storage
   * already confined to `documentsWorkdir` (e.g. `ScopedStorage` — see
   * `build-agent-loop.ts`), never the raw process-wide backend: this write
   * sits outside the personality toolset boundary otherwise.
   */
  storage?: Storage;
  /**
   * The bound personality's resolved `fs_reach.workdir` (already
   * `${ETHOS_HOME}`/`${self}`-substituted — see `deriveFsReachPaths` in
   * `@ethosagent/core`). When set alongside `storage`, the per-call
   * transcript artifact (never the `call-captures-index.md` digest, which
   * stays memory-scope only) is additionally written to
   * `<documentsWorkdir>/call-captures/<artifact.key>` so it shows up in the
   * web app's Documents tab.
   */
  documentsWorkdir?: string;
  /**
   * Lazy provider for the content-summarization step, mirroring
   * `CompletionVerifierOptions.getProvider` (`tools-kanban`'s verifier) —
   * wiring defers construction until first use. Absent means the plain
   * roll-up is always used instead of an LLM summary.
   */
  getSummaryProvider?: () => Promise<LLMProvider>;
  /** Forwarded to `runTranscriptSession`'s fixed STT window size. Exposed for tests. */
  windowMs?: number;
  /** Injectable clock for deterministic key/digest timestamps. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RunCallCaptureInput {
  /** Detected calling app if known, e.g. "zoom". Sanitized with a "call" fallback — see sanitizeSource. */
  source?: string;
  scopeId: string;
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  abortSignal: AbortSignal;
  /**
   * Optional per-entry live callback (plan/phases/call-capture-desktop-ux.md,
   * P3) — fires once per `TranscriptEntry` yielded by `runTranscriptSession`,
   * in the same order they're pushed into `entries` below, so a UI
   * subscriber (the desktop pill's popover) can display partial transcript
   * text incrementally instead of only after the call ends. Purely
   * additive: callers that don't pass it (the CLI path) see no behavior
   * change.
   */
  onEntry?: (entry: TranscriptEntry) => void;
  /**
   * Optional per-chunk live audio-level callback — fires once per PCM chunk
   * on EACH stream (mic → speaker 'you', tap → speaker 'other') with an
   * RMS level normalized 0.0-1.0 (see `computeRmsLevel`). Much higher
   * frequency than `onEntry` (~100-200ms vs ~8s), for a live level-meter UI
   * that needs faster feedback than transcript text can provide. Purely
   * additive: callers that don't pass it see no behavior change, and the
   * streams reaching `runTranscriptSession` are byte-for-byte identical
   * whether or not this is supplied.
   */
  onAudioLevel?: (speaker: Speaker, level: number, at: number) => void;
}

export type CallCaptureResult =
  | { ok: true; artifactKey: string; summary: string; warning?: string }
  | { ok: false; code: string; error: string; cause?: unknown };

export async function runCallCapture(
  opts: CallCaptureToolsOptions,
  input: RunCallCaptureInput,
): Promise<CallCaptureResult> {
  const { tapCapture, micCapture, sttProvider, memory } = opts;
  if (!tapCapture || !micCapture || !sttProvider || !memory) {
    return {
      ok: false,
      code: 'not_available',
      error:
        'Call capture is not configured — tap capture, mic capture, STT, or memory is not wired.',
    };
  }

  const source = sanitizeSource(input.source);
  const startedAt = (opts.now ?? Date.now)();

  let tapChunks: AsyncIterable<PcmChunk>;
  let micChunks: AsyncIterable<PcmChunk>;
  try {
    tapChunks = await tapCapture.start();
    micChunks = await micCapture.start();
  } catch (err) {
    // Bug 5 fix: stop whichever stream(s) already started before returning —
    // the `finally` below is never reached from inside this catch's own
    // return. Both `.stop()` calls are safe no-ops on a stream that never
    // started (TapCapture/MicCapture guard with `this.handle?.stop()`).
    tapCapture.stop();
    micCapture.stop();
    return {
      ok: false,
      code: 'execution_failed',
      error: `Failed to start call capture: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  }

  const micWithLevel = withLevelReporting(micChunks, 'you', (speaker, level, at) =>
    input.onAudioLevel?.(speaker, level, at),
  );
  const tapWithLevel = withLevelReporting(tapChunks, 'other', (speaker, level, at) =>
    input.onAudioLevel?.(speaker, level, at),
  );

  const entries: TranscriptEntry[] = [];
  const sessionDone = (async () => {
    for await (const entry of runTranscriptSession(
      { mic: micWithLevel, tap: tapWithLevel },
      sttProvider,
      {
        windowMs: opts.windowMs,
      },
    )) {
      entries.push(entry);
      input.onEntry?.(entry);
    }
  })();

  // Transcribe until the caller aborts — the same "transcribe until stopped"
  // lifecycle meet_join uses. The daemon that detects the call ending aborts
  // this signal; stop both streams cleanly and drain whatever was already in
  // flight so a call ending mid-capture still saves whatever was captured —
  // never silently discarded.
  try {
    await waitForAbort(input.abortSignal);
  } finally {
    tapCapture.stop();
    micCapture.stop();
  }
  await sessionDone;

  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const hasEntries = sorted.length > 0;
  const body = buildTranscriptBody(sorted, source);
  const summaryResult = await summarizeTranscript(sorted, body, opts.getSummaryProvider);
  const { summary } = summaryResult;

  const artifact = buildCallCaptureArtifact({ source, startedAt, body, hasEntries, summary });
  const memCtx: MemoryContext = {
    scopeId: input.scopeId,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    platform: input.platform,
    workingDir: input.workingDir,
  };
  await memory.sync([{ action: 'replace', key: artifact.key, content: artifact.markdown }], memCtx);

  // Documents-tab mirror (P4): the per-call transcript only, never the
  // digest index below. Both `storage` and `documentsWorkdir` are optional —
  // absent (the general case for a personality with no `fs_reach.workdir`)
  // means this is a graceful no-op, not an error.
  if (opts.storage && opts.documentsWorkdir) {
    const callCapturesDir = join(opts.documentsWorkdir, 'call-captures');
    await opts.storage.mkdir(callCapturesDir);
    // writeAtomic, not write: a crash mid-write must never leave a truncated
    // .md file sitting in the user's actual Documents folder.
    await opts.storage.writeAtomic(join(callCapturesDir, artifact.key), artifact.markdown);
  }

  const digestLine = buildDigestLine({ startedAt, source, summary, key: artifact.key, hasEntries });
  await memory.sync([{ action: 'add', key: CALL_CAPTURES_INDEX_KEY, content: digestLine }], memCtx);

  return {
    ok: true,
    artifactKey: artifact.key,
    summary,
    ...(summaryResult.error ? { warning: summaryResult.error } : {}),
  };
}

/** Wraps a PCM chunk stream to report each chunk's RMS level via callback
 * WITHOUT altering what flows downstream — yields the exact same chunk,
 * unchanged, in the same order. Fully transparent to `runTranscriptSession`:
 * it receives every chunk it always did, just via this pass-through. */
async function* withLevelReporting(
  stream: AsyncIterable<PcmChunk>,
  speaker: Speaker,
  onLevel: (speaker: Speaker, level: number, at: number) => void,
): AsyncGenerator<PcmChunk> {
  for await (const chunk of stream) {
    onLevel(speaker, computeRmsLevel(chunk), Date.now());
    yield chunk;
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
