// Phase 3 manual-verification entry point (plan/phases/
// call-capture-extension.md "Phase 3 — Audio capture spike, standalone").
// Starts the REAL `TapCapture` (other participants, via vendored audiotee)
// and the REAL `MicCapture` (you, via the compiled mic-capture binary)
// concurrently, runs both through the windowed streamed-STT wiring
// (`runTranscriptSession`) for a fixed duration, and prints the merged,
// speaker-labeled transcript at the end for a human to eyeball quality.
//
// Uses a real `openai-stt` provider when an `OPENAI_API_KEY` env var is set
// (logged which); falls back to a fake energy-based provider — proving
// pipeline wiring only, not transcript content — if it isn't. Always logs
// which validation tier ran.
//
// Reads credentials from a plain env var, not from `~/.ethos/config.yaml` /
// the secrets vault: resolving `${secrets:...}` refs requires constructing a
// `Storage` (`FsStorage`), and `packages/types/src/__tests__/
// storage-construction-boundary.test.ts` (P2.4) holds `extensions/*` to a
// deliberately EMPTY allowlist for that — library/extension code must
// RECEIVE an injected `Storage`, never construct one itself, even in a
// manual-verification script. To actually exercise the real provider, export
// the resolved key from `~/.ethos/secrets/auxiliary/asr/apiKey` (or wherever
// your `auxiliary.asr.apiKey` secret ref resolves to) as `OPENAI_API_KEY`
// before running this script.
//
// Not wired into the production `ethos` CLI — that's Phase 4 scope. This is
// the only file in this package that reaches for a concrete STT provider
// (`@ethosagent/voice-providers` is a devDependency, used only here — the
// same reason `extensions/platform-voice` keeps it as a devDependency rather
// than a runtime one).
//
// Run with:
//   OPENAI_API_KEY=sk-... pnpm --filter @ethosagent/platform-callcapture exec tsx src/phase3-cli.ts [durationSeconds]

import type { SttProvider } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { OpenAiSttProvider } from '@ethosagent/voice-providers';
import { MicCapture } from './mic-capture';
import { TapCapture } from './tap-capture';
import type { TranscriptEntry } from './transcript-session';
import { runTranscriptSession } from './transcript-session';

const OPENAI_STT_MODEL = 'whisper-1';

const DEFAULT_DURATION_SECONDS = 15;
/** Below this RMS, a window is treated as silence by the fake STT fallback. */
const FAKE_STT_SILENCE_RMS_THRESHOLD = 200;

/** A trivial RMS-energy-based fake `SttProvider` — proves the capture ->
 * window -> transcribeStream -> speaker-labeled-merge PIPELINE WIRING is
 * correct without claiming real transcript content. Used only when a real
 * provider can't be constructed (see `resolveSttProvider` below). */
function createFakeSttProvider(): SttProvider {
  return {
    name: 'phase3-fake-energy-stt',
    caps: { kind: 'stt', formats: ['wav'], contractVersion: STT_CONTRACT_VERSION },
    async transcribeBuffer(audio) {
      // `createBufferedSttAdapter` (the wrapper this fake gets run through,
      // since it doesn't advertise caps.streaming) hands us one WAV per
      // window — a 44-byte header followed by 16-bit LE PCM samples.
      const pcm = audio.data.subarray(44);
      const sampleCount = Math.floor(pcm.length / 2);
      let sumSquares = 0;
      for (let i = 0; i < sampleCount; i++) {
        const unsigned = (pcm[i * 2] ?? 0) | ((pcm[i * 2 + 1] ?? 0) << 8);
        const sample = (unsigned << 16) >> 16; // sign-extend from uint16 to int16
        sumSquares += sample * sample;
      }
      const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
      return rms > FAKE_STT_SILENCE_RMS_THRESHOLD ? `[audio detected, rms=${Math.round(rms)}]` : '';
    },
  };
}

interface ResolvedStt {
  provider: SttProvider;
  tier: 'real-openai-stt' | 'fake-energy';
}

/** Builds a real `openai-stt` provider from `OPENAI_API_KEY` if it's set in
 * the environment (see the file header for why this doesn't resolve
 * `~/.ethos/config.yaml`'s `${secrets:...}` refs directly). Falls back to
 * the fake provider when the env var is absent, logging why. */
function resolveSttProvider(): ResolvedStt {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return {
      provider: new OpenAiSttProvider({ apiKey, model: OPENAI_STT_MODEL }),
      tier: 'real-openai-stt',
    };
  }
  console.log(
    '[phase3-cli] OPENAI_API_KEY is not set — falling back to the fake energy-based provider. ' +
      "This run validates PIPELINE WIRING only, not real transcript content. See this file's " +
      'header comment for how to export a real key.',
  );
  return { provider: createFakeSttProvider(), tier: 'fake-energy' };
}

function speakerLabel(speaker: TranscriptEntry['speaker']): string {
  return speaker === 'you' ? 'You' : 'Other participant';
}

async function main(): Promise<void> {
  const durationSeconds = Number(process.argv[2]) || DEFAULT_DURATION_SECONDS;
  console.log(`[phase3-cli] starting (duration=${durationSeconds}s)...`);

  const { provider: sttProvider, tier } = resolveSttProvider();
  console.log(`[phase3-cli] STT validation tier: ${tier}`);

  const tap = new TapCapture({
    onWaiting: (s) => console.log(`[phase3-cli] tap: still waiting for the tap to start, ${s}s...`),
    onRuntimeError: (m) => console.error(`[phase3-cli] tap: runtime error: ${m}`),
  });
  const mic = new MicCapture({
    onWaiting: (s) => console.log(`[phase3-cli] mic: still waiting to start, ${s}s...`),
    onRuntimeError: (m) => console.error(`[phase3-cli] mic: runtime error: ${m}`),
  });

  console.log('[phase3-cli] starting tap capture (other participants — system audio)...');
  const tapChunks = await tap.start();
  console.log('[phase3-cli] tap ready.');

  console.log('[phase3-cli] starting mic capture (you)...');
  const micChunks = await mic.start();
  console.log('[phase3-cli] mic ready.');

  console.log(
    `[phase3-cli] capturing for ${durationSeconds}s — speak into the mic, and/or play audio ` +
      'through system output, to produce transcript content...',
  );

  const entries: TranscriptEntry[] = [];
  const sessionDone = (async () => {
    for await (const entry of runTranscriptSession(
      { mic: micChunks, tap: tapChunks },
      sttProvider,
    )) {
      console.log(`[phase3-cli] live: ${speakerLabel(entry.speaker)}: ${entry.text}`);
      entries.push(entry);
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
  console.log('[phase3-cli] duration elapsed — stopping capture...');
  tap.stop();
  mic.stop();

  await sessionDone;

  console.log('\n=== Merged transcript ===');
  if (entries.length === 0) {
    console.log('(no speech detected on either stream)');
  } else {
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    for (const entry of sorted) {
      console.log(
        `[${new Date(entry.at).toISOString()}] ${speakerLabel(entry.speaker)}: ${entry.text}`,
      );
    }
  }
  console.log(`\n[phase3-cli] STT validation tier was: ${tier}`);
}

main().catch((err) => {
  console.error(`[phase3-cli] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
