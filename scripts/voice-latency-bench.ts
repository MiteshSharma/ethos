// Voice latency harness. Two tiers, two modes, one budget module.
//
//   Mock (CI, no credentials, deterministic):
//     pnpm tsx scripts/voice-latency-bench.ts [--assert-budget] \
//       [--endpoint-ms=N] [--llm-ms=N] [--tts-ms=N]
//     pnpm tsx scripts/voice-latency-bench.ts --tier=realtime [--assert-budget] \
//       [--realtime-commit-ms=N] [--realtime-audio-ms=N] [--no-commit-marker]
//
//   Live (whatever ~/.ethos/config.yaml has configured — real providers,
//   real network, real models):
//     pnpm tsx scripts/voice-latency-bench.ts --live [--turns=N] [--assert-budget]
//     pnpm tsx scripts/voice-latency-bench.ts --live --tier=realtime \
//       [--entry=<roster key>] [--turns=N] [--audio=file.wav] [--assert-budget]
//
// Pipeline tier (`VOICE_LATENCY_BUDGET_MS`):
//   endpoint ≤300ms | STT ≤200ms | LLM first sentence ≤800ms
//   | first audio ≤300ms | mouth-to-ear ≤1600ms
//
// Realtime tier (`VOICE_REALTIME_LATENCY_BUDGET_MS`):
//   endpoint ≤300ms | provider first audio ≤500ms | mouth-to-ear ≤800ms
//
// The numbers come from the per-turn SPANS a real session writes, not from a
// parallel measurement the bench invented — so what the bench reports is what
// the deployment's own telemetry would show. Both modes report p50/p90/p99 and
// check budgets against p90.
//
// WHAT THE REALTIME TIER CAN AND CANNOT MEASURE. A hosted realtime session
// reports one moment — its first audio frame — so mouth-to-ear is measured and
// the two stages under it are an ATTRIBUTION of it, split at whatever commit
// marker the provider offers (its final user transcript). Providers that
// transcribe asynchronously deliver that marker after the audio, or not at all;
// then the endpoint stage is absent and the provider stage carries the
// endpointing inside it, and the bench says so instead of printing a zero. In
// mock mode the split is exact because the mock provider emits the marker.
// Nothing here measures the BROWSER's own capture and playout — the tier's real
// deployment holds those sockets in a page — so a live realtime run is the
// provider's leg, honestly labelled, not the full user experience.
//
// A DEPLOYED realtime call writes the same `realtime_first_audio` span this
// harness builds by hand: the browser reports its measured mouth-to-ear on the
// control socket (`realtime_turn_latency`) and `RealtimeControlLane` records it
// into the deployment's voice span writer, stamped with the provider that
// served the call. The budget below is therefore checkable against production
// telemetry with these same two functions, not only against this script.
//
// scripts/ is tooling (like apps/ethos), so console.* is allowed here.

import { readFileSync } from 'node:fs';
import { readRawConfig } from '@ethosagent/config';
import { resolveRealtimeProvider, resolveSttProvider, resolveTtsProvider } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  PcmChunk,
  RealtimeEvent,
  RealtimeSession,
  StreamingSttProvider,
  StreamingTtsProvider,
  SttProvider,
  TtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { createFakeRealtimeProvider } from '@ethosagent/voice-providers';
import {
  type AgentTurnRunner,
  BufferedVoiceSpanWriter,
  EnergyVad,
  summarizeLatency,
  turnLatenciesFromSpans,
  VOICE_LATENCY_BUDGET_MS,
  VOICE_REALTIME_LATENCY_BUDGET_MS,
  type VoiceLatencyReport,
  type VoiceLatencyTier,
  VoiceSession,
  type VoiceTurnSpan,
} from '@ethosagent/voice-session';
import { createBuiltinVoiceRegistries } from '@ethosagent/wiring';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}

// --- mock providers with injectable per-stage latency ---------------------

function mockStt(endpointMs: number): StreamingSttProvider {
  return {
    name: 'mock-stt',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => 'what is the weather today',
    async *transcribeStream() {
      // Endpoint stability + STT settling.
      await sleep(endpointMs);
      yield { text: 'what is the weather today', isFinal: true };
    },
  };
}

function mockRunner(llmMs: number): AgentTurnRunner {
  return {
    async *run(): AsyncGenerator<AgentEvent> {
      // Time-to-first-sentence: model latency before the first token lands.
      await sleep(llmMs);
      yield { type: 'text_delta', text: 'The weather today is clear and mild. ' };
      yield { type: 'text_delta', text: 'Expect a light breeze this afternoon.' };
    },
  };
}

function mockTts(ttsMs: number): StreamingTtsProvider {
  return {
    name: 'mock-tts',
    caps: { kind: 'tts', formats: ['pcm'], streaming: true, contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([0]), format: 'pcm' }),
    async *synthesizeStream(text) {
      let first = true;
      for await (const t of text) {
        if (first) {
          await sleep(ttsMs); // first-chunk latency
          first = false;
        }
        yield { audio: new Uint8Array([t.length & 0xff]), format: 'pcm' };
      }
    },
  };
}

class MarkerVad {
  process(chunk: PcmChunk): { speech: boolean } {
    return { speech: chunk.data.some((v) => v !== 0) };
  }
}

function speechFrame(): PcmChunk {
  return { data: new Int16Array(320).fill(12000), sampleRate: 16000 };
}
function silenceFrame(): PcmChunk {
  return { data: new Int16Array(320), sampleRate: 16000 };
}

/** Collects flushed spans in memory — the bench IS the telemetry sink. */
function collectingSpanWriter(into: VoiceTurnSpan[]): BufferedVoiceSpanWriter {
  return new BufferedVoiceSpanWriter({
    sink: { write: (spans) => void into.push(...spans) },
    // Flush only on close: the bench reads them after the run, and a timer
    // firing mid-turn is exactly the audio-path work spans exist to avoid.
    flushIntervalMs: 0,
  });
}

// --- one measured utterance ------------------------------------------------

/**
 * A clock that runs at wall-clock speed but can be pushed forward on demand.
 *
 * Endpoint detection needs hundreds of milliseconds of silence to have
 * "passed"; sleeping through it would add real seconds per turn for no signal.
 * So the silence is advanced virtually, and everything after the utterance
 * commits — which is every provider call the budget is about — is measured in
 * real elapsed time.
 */
function benchClock(): { now: () => number; advance: (ms: number) => void } {
  const t0 = performance.now();
  let virtual = 0;
  return {
    now: () => virtual + (performance.now() - t0),
    advance: (ms) => {
      virtual += ms;
    },
  };
}

const FRAME_MS = 20;
/**
 * Silence the detector must see before it calls the utterance over. It is part
 * of endpoint latency by definition — you cannot know someone stopped talking
 * faster than you are willing to wait — so a threshold at or above the 300ms
 * endpoint budget can never pass. Override with `--endpoint-silence-ms=N`.
 */
const DEFAULT_ENDPOINT_SILENCE_MS = 250;
const MAX_SILENCE_FRAMES = 60;

/**
 * Drive one utterance through a session and return the clock reading at which
 * the user stopped talking. Endpoint latency is that reading subtracted from
 * when the turn actually started — the one stage no span can cover, because
 * endpointing happens before the turn exists.
 *
 * Silence stops the moment the session commits, so no virtual time leaks into
 * the provider stages.
 */
async function driveUtterance(
  session: VoiceSession,
  clock: { now: () => number; advance: (ms: number) => void },
  speech: readonly PcmChunk[],
): Promise<number> {
  for (const frame of speech) {
    clock.advance(FRAME_MS);
    session.pushAudio(frame);
  }
  const speechEndedAt = clock.now();

  const silence = silenceFrame();
  for (let i = 0; i < MAX_SILENCE_FRAMES; i++) {
    clock.advance(FRAME_MS);
    session.pushAudio(silence);
    // The commit happens inside pushAudio; stop feeding virtual silence the
    // moment the turn starts, or its duration lands in the STT span.
    if (session.getState() !== 'listening') break;
  }
  await session.idle();
  return speechEndedAt;
}

function spansTurnIds(spans: readonly VoiceTurnSpan[]): Set<string> {
  return new Set(spans.map((s) => s.turnId));
}

/**
 * Endpoint latency for the turns that appeared since `before`: how long after
 * the user stopped talking the turn actually began. Read off the spans' own
 * clock, so it composes with every other stage without a second time source.
 */
function recordEndpoints(
  spans: readonly VoiceTurnSpan[],
  before: ReadonlySet<string>,
  speechEndedAt: number,
  into: Record<string, number>,
): void {
  for (const id of spansTurnIds(spans)) {
    if (before.has(id) || into[id] !== undefined) continue;
    const starts = spans.filter((s) => s.turnId === id).map((s) => s.startTs);
    if (starts.length === 0) continue;
    into[id] = Math.max(0, Math.min(...starts) - speechEndedAt);
  }
}

// --- realtime tier ---------------------------------------------------------

// The mock hosted realtime provider is the SHARED fake
// (`createFakeRealtimeProvider` in `@ethosagent/voice-providers`), not a second
// one written here: it commits on silence like a hosted VAD, emits the user
// transcript as its commit marker, and can be told to withhold that marker
// (`emitCommitMarker: false`), which is the case a provider that transcribes
// asynchronously actually presents.

/** One realtime turn's observations. `commitAt` is null when no marker landed. */
interface RealtimeTurnMarks {
  speechEndedAt: number;
  commitAt: number | null;
  firstAudioAt: number;
}

/**
 * Drive one utterance through a realtime session and time the provider's leg.
 *
 * Everything here is REAL elapsed time: unlike the pipeline tier there is no
 * silence window of ours to fast-forward through — the waiting IS the provider
 * deciding you stopped talking, and virtualizing it would delete the thing the
 * endpoint budget is about.
 */
async function driveRealtimeUtterance(
  session: RealtimeSession,
  events: AsyncIterator<RealtimeEvent>,
  speech: readonly PcmChunk[],
  timeoutMs: number,
): Promise<RealtimeTurnMarks | null> {
  for (const frame of speech) await session.sendAudio(pcm16Bytes(frame));
  const speechEndedAt = performance.now();
  let commitAt: number | null = null;

  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (performance.now() > deadline) return null;
    const next = await Promise.race([
      events.next(),
      sleep(Math.max(0, deadline - performance.now())).then(() => null),
    ]);
    if (!next || next.done) return null;
    const event = next.value;
    if (
      event.type === 'transcript' &&
      event.role === 'user' &&
      event.isFinal &&
      commitAt === null
    ) {
      commitAt = performance.now();
      continue;
    }
    if (event.type === 'audio') {
      return { speechEndedAt, commitAt, firstAudioAt: performance.now() };
    }
    if (event.type === 'closed') return null;
  }
}

/** PCM16 frame → the little-endian bytes the realtime contract carries. */
function pcm16Bytes(chunk: PcmChunk): Uint8Array {
  const out = new Uint8Array(chunk.data.length * 2);
  for (let i = 0; i < chunk.data.length; i++) {
    const value = chunk.data[i] ?? 0;
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return out;
}

/**
 * Turn the observed marks into the spans a realtime turn writes, plus the
 * commit-marker delay the latency module treats as `endpoint`.
 *
 * The span is cumulative from the moment the user stopped talking — this tier's
 * only observable turn start — so it IS mouth-to-ear, and the provider's own
 * leg is what remains after the marker. No marker means no endpoint entry: the
 * endpointing is then inside the provider stage, and saying so beats printing a
 * zero that would pass a budget nothing measured.
 */
function recordRealtimeTurn(
  marks: RealtimeTurnMarks,
  turnId: string,
  providerId: string,
  spans: VoiceTurnSpan[],
  endpointByTurn: Record<string, number>,
): void {
  spans.push({
    turnId,
    stage: 'realtime_first_audio',
    startTs: marks.speechEndedAt,
    endTs: marks.firstAudioAt,
    status: 'ok',
    realtimeProvider: providerId,
  });
  if (marks.commitAt !== null) {
    endpointByTurn[turnId] = Math.max(0, marks.commitAt - marks.speechEndedAt);
  }
}

async function runMockRealtime(assertBudget: boolean): Promise<boolean> {
  const commitMs = arg('realtime-commit-ms', 250);
  const audioMs = arg('realtime-audio-ms', 350);
  const emitCommitMarker = !process.argv.includes('--no-commit-marker');
  const turns = Math.max(1, Math.trunc(arg('turns', 5)));

  const provider = createFakeRealtimeProvider({ commitMs, audioMs, emitCommitMarker });
  const session = await provider.open({ instructions: 'bench' });
  const events = session.events[Symbol.asyncIterator]();
  const speech = Array.from({ length: 5 }, speechFrame);

  const spans: VoiceTurnSpan[] = [];
  const endpointByTurn: Record<string, number> = {};
  for (let i = 0; i < turns; i++) {
    const marks = await driveRealtimeUtterance(session, events, speech, 5_000);
    if (!marks) break;
    recordRealtimeTurn(marks, `mock-${i}`, provider.name, spans, endpointByTurn);
  }
  await session.close();

  const report = summarizeLatency(turnLatenciesFromSpans(spans, endpointByTurn), 'realtime');
  printReport('Realtime tier latency budget (mock provider)', report);
  // Said plainly, because a green table is persuasive and this one is not
  // evidence about any provider: the mock sleeps for exactly as long as the
  // flags say, so passing proves the span→budget path works, nothing more.
  console.log(
    '\n  Mock timings come from --realtime-commit-ms / --realtime-audio-ms, so this\n' +
      '  run exercises the measurement path, not a provider. The claim about a real\n' +
      "  provider comes from `pnpm bench:voice:live:realtime` or from a deployment's\n" +
      '  own realtime_first_audio spans.',
  );
  if (!emitCommitMarker) {
    console.log(
      '\n  No commit marker was emitted, so there is no endpoint row: the\n' +
        "  provider's endpointing is inside the first-audio stage.",
    );
  }
  return finish(report, assertBudget);
}

async function runLiveRealtime(assertBudget: boolean): Promise<boolean> {
  const turns = Math.max(1, Math.trunc(arg('turns', 5)));
  const audioPath = stringArg('audio');
  const storage = new FsStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.error('No ~/.ethos/config.yaml — run `ethos setup` before the live bench.');
    return false;
  }

  const roster = config.voice?.realtime?.providers ?? {};
  const entryName = stringArg('entry') ?? config.voice?.realtime?.default;
  const entry = entryName ? roster[entryName] : undefined;
  if (!entry) {
    console.error(
      'No realtime entry to bench. Configure voice.realtime.providers.<name> and either\n' +
        'voice.realtime.default or --entry=<name>.',
    );
    return false;
  }

  const trusted = config.voice?.trustedPlugins ? new Set(config.voice.trustedPlugins) : undefined;
  const registries = createBuiltinVoiceRegistries();
  // Same resolution path (and same local-only egress gate) every surface uses.
  const resolution = await resolveRealtimeProvider({
    registry: registries.realtimeProviders,
    providerName: entry.provider,
    providerConfig: {
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      model: entry.model,
      voice: entry.voice,
    },
    ...(trusted ? { trustedVoicePlugins: trusted } : {}),
  });
  if (!resolution.ok) {
    console.error(`Realtime: ${resolution.error}`);
    return false;
  }
  console.log(
    `Live realtime provider — ${resolution.providerId}` +
      `${entry.model ? ` · ${entry.model}` : ''}${trusted ? ' (egress gate armed)' : ''}`,
  );
  if (!audioPath) {
    console.log(
      'No --audio=<file.wav>: feeding a synthetic tone. A hosted VAD will not commit a\n' +
        'turn for it, so expect no turns at all. Pass a recorded utterance.',
    );
  }

  const session = await resolution.provider.open({
    instructions: 'You are a latency benchmark. Answer in one short sentence.',
    ...(entry.model ? { model: entry.model } : {}),
  });
  const events = session.events[Symbol.asyncIterator]();
  const speech = audioPath ? readWavFrames(audioPath) : Array.from({ length: 25 }, speechFrame);

  const spans: VoiceTurnSpan[] = [];
  const endpointByTurn: Record<string, number> = {};
  let missedMarker = 0;
  for (let i = 0; i < turns; i++) {
    const marks = await driveRealtimeUtterance(session, events, speech, 15_000);
    if (!marks) break;
    if (marks.commitAt === null) missedMarker++;
    recordRealtimeTurn(marks, `live-${i}`, resolution.providerId, spans, endpointByTurn);
    process.stdout.write(`  turn ${i + 1}/${turns}\r`);
  }
  await session.close();

  const report = summarizeLatency(turnLatenciesFromSpans(spans, endpointByTurn), 'realtime');
  printReport(`Realtime tier latency (live, ${spans.length} turns)`, report);
  if (missedMarker > 0) {
    console.log(
      `\n  ${missedMarker} of ${spans.length} turns had no commit marker before the first\n` +
        "  audio frame, so the provider's endpointing is inside the first-audio\n" +
        '  stage for those turns. Mouth-to-ear is unaffected.',
    );
  }
  return finish(report, assertBudget);
}

// --- mock mode -------------------------------------------------------------

async function runMock(assertBudget: boolean): Promise<boolean> {
  const sttMs = arg('endpoint-ms', 120);
  const silenceMs = arg('endpoint-silence-ms', DEFAULT_ENDPOINT_SILENCE_MS);
  const llmMs = arg('llm-ms', 550);
  const ttsMs = arg('tts-ms', 180);

  const spans: VoiceTurnSpan[] = [];
  const writer = collectingSpanWriter(spans);
  const clock = benchClock();
  const session = new VoiceSession({
    runner: mockRunner(llmMs),
    stt: mockStt(sttMs),
    tts: mockTts(ttsMs),
    vad: new MarkerVad(),
    now: clock.now,
    spans: writer,
    laneKey: 'bench:mock',
    config: { endpointSilenceMs: silenceMs },
  });

  const speech = Array.from({ length: 5 }, speechFrame);
  const endpointByTurn: Record<string, number> = {};
  const before = spansTurnIds(spans);
  const speechEndedAt = await driveUtterance(session, clock, speech);
  await writer.close();
  recordEndpoints(spans, before, speechEndedAt, endpointByTurn);

  const report = summarizeLatency(turnLatenciesFromSpans(spans, endpointByTurn));
  printReport('Voice pipeline latency budget (mock providers)', report);
  return finish(report, assertBudget);
}

// --- live mode -------------------------------------------------------------

async function runLive(assertBudget: boolean): Promise<boolean> {
  const turns = Math.max(1, Math.trunc(arg('turns', 10)));
  const audioPath = stringArg('audio');
  const storage = new FsStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.error('No ~/.ethos/config.yaml — run `ethos setup` before the live bench.');
    return false;
  }

  const asr = config.auxiliary?.asr;
  const tts = config.auxiliary?.tts;
  const trusted = config.voice?.trustedPlugins ? new Set(config.voice.trustedPlugins) : undefined;
  const registries = createBuiltinVoiceRegistries();

  // Resolution goes through the same functions every surface uses, INCLUDING
  // the local-only egress gate — a bench that quietly bypassed the gate would
  // measure a provider the deployment refuses to use.
  const sttResolution = await resolveSttProvider({
    registry: registries.sttProviders,
    providerName: asr?.provider,
    providerConfig: {
      apiKey: asr?.apiKey,
      baseUrl: asr?.baseUrl,
      model: asr?.model,
      command: asr?.command,
      timeout: asr?.timeout,
    },
    ...(trusted ? { trustedVoicePlugins: trusted } : {}),
  });
  const ttsResolution = await resolveTtsProvider({
    registry: registries.ttsProviders,
    providerName: tts?.provider,
    providerConfig: {
      apiKey: tts?.apiKey,
      baseUrl: tts?.baseUrl,
      model: tts?.model,
      voice: tts?.voice,
      command: tts?.command,
      outputFormat: tts?.outputFormat,
      timeout: tts?.timeout,
      maxTextLength: tts?.maxTextLength,
    },
    ...(trusted ? { trustedVoicePlugins: trusted } : {}),
  });
  if (!sttResolution.ok || !ttsResolution.ok) {
    if (!sttResolution.ok) console.error(`STT: ${sttResolution.error}`);
    if (!ttsResolution.ok) console.error(`TTS: ${ttsResolution.error}`);
    return false;
  }
  console.log(
    `Live providers — stt ${sttResolution.providerId} · tts ${ttsResolution.providerId}` +
      `${trusted ? ' (egress gate armed)' : ''}`,
  );

  const speech = audioPath ? readWavFrames(audioPath) : Array.from({ length: 25 }, speechFrame);
  if (!audioPath) {
    console.log(
      'No --audio=<file.wav>: feeding a synthetic tone. A real transcriber will return\n' +
        'nothing for it, so expect the STT stage only. Pass a recorded utterance to\n' +
        'measure the LLM and TTS stages too.',
    );
  }

  const spans: VoiceTurnSpan[] = [];
  const writer = collectingSpanWriter(spans);
  const endpointByTurn: Record<string, number> = {};

  // The LLM is deliberately NOT a live provider here: the bench measures the
  // voice pipeline, and a fixed reply keeps model variance out of the TTS
  // numbers. Everything else is the real thing.
  const clock = benchClock();
  const session = new VoiceSession({
    runner: fixedReplyRunner(),
    stt: sttResolution.provider as SttProvider,
    tts: ttsResolution.provider as TtsProvider,
    vad: new EnergyVad(),
    spans: writer,
    laneKey: 'bench:live',
    now: clock.now,
    config: { endpointSilenceMs: arg('endpoint-silence-ms', DEFAULT_ENDPOINT_SILENCE_MS) },
  });

  for (let i = 0; i < turns; i++) {
    const before = spansTurnIds(spans);
    const speechEndedAt = await driveUtterance(session, clock, speech);
    await writer.flush();
    recordEndpoints(spans, before, speechEndedAt, endpointByTurn);
    process.stdout.write(`  turn ${i + 1}/${turns}\r`);
  }
  await writer.close();

  const report = summarizeLatency(turnLatenciesFromSpans(spans, endpointByTurn));
  printReport(`Voice pipeline latency (live, ${turns} turns)`, report);
  return finish(report, assertBudget);
}

/** A deterministic two-sentence reply, so TTS is measured and the LLM is not. */
function fixedReplyRunner(): AgentTurnRunner {
  return {
    async *run(): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'The weather today is clear and mild. ' };
      yield { type: 'text_delta', text: 'Expect a light breeze this afternoon.' };
    },
  };
}

function stringArg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * Read a 16-bit PCM WAV into VAD-sized frames. Deliberately minimal: this reads
 * a file the operator recorded for the bench, not untrusted input, and a real
 * decoder would be a dependency for one script.
 */
function readWavFrames(path: string): PcmChunk[] {
  const bytes = readFileSync(path);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path} is not a RIFF WAV file`);
  }
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  if (bitsPerSample !== 16) throw new Error(`${path}: expected 16-bit PCM, got ${bitsPerSample}`);

  // Walk the chunk list rather than assuming the canonical 44-byte header.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const samples = new Int16Array(size >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(offset + 8 + i * 2);
      const perFrame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
      const frames: PcmChunk[] = [];
      for (let i = 0; i < samples.length; i += perFrame) {
        frames.push({ data: samples.slice(i, i + perFrame), sampleRate });
      }
      return frames;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

// --- reporting -------------------------------------------------------------

function printReport(title: string, report: VoiceLatencyReport): void {
  const rows = report.stages.map((s) => ({
    stage: s.stage,
    p50: `${Math.round(s.p50)}ms`,
    p90: `${Math.round(s.p90)}ms`,
    p99: `${Math.round(s.p99)}ms`,
    budget: `≤ ${s.budgetMs}ms`,
    ok: s.withinBudget ? 'PASS' : 'FAIL',
  }));
  if (rows.length === 0) {
    console.log(`\n${title}\n\n  No spans recorded — nothing to report.`);
    return;
  }

  const width = (key: keyof (typeof rows)[0], header: string): number =>
    Math.max(...rows.map((r) => r[key].length), header.length);
  const w = {
    stage: width('stage', 'Stage'),
    p50: width('p50', 'p50'),
    p90: width('p90', 'p90'),
    p99: width('p99', 'p99'),
    budget: width('budget', 'Budget'),
  };
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(`\n${title}  —  ${report.turns} turn(s)\n`);
  console.log(
    `  ${pad('Stage', w.stage)}  ${pad('p50', w.p50)}  ${pad('p90', w.p90)}  ` +
      `${pad('p99', w.p99)}  ${pad('Budget', w.budget)}  Result`,
  );
  console.log(
    `  ${'-'.repeat(w.stage)}  ${'-'.repeat(w.p50)}  ${'-'.repeat(w.p90)}  ` +
      `${'-'.repeat(w.p99)}  ${'-'.repeat(w.budget)}  ------`,
  );
  for (const r of rows) {
    console.log(
      `  ${pad(r.stage, w.stage)}  ${pad(r.p50, w.p50)}  ${pad(r.p90, w.p90)}  ` +
        `${pad(r.p99, w.p99)}  ${pad(r.budget, w.budget)}  ${r.ok}`,
    );
  }
  console.log('\n  Budgets are checked against p90.');
}

function finish(report: VoiceLatencyReport, assertBudget: boolean): boolean {
  if (!assertBudget) return true;
  if (report.withinBudget) {
    console.log('\nPASS: every measured stage is within its budget.');
    return true;
  }
  const missed = report.stages
    .filter((s) => !s.withinBudget)
    .map((s) => `${s.stage} p90 ${Math.round(s.p90)}ms > ${s.budgetMs}ms`)
    .join('; ');
  console.error(`\nFAIL: ${missed}`);
  return false;
}

function tierArg(): VoiceLatencyTier {
  return stringArg('tier') === 'realtime' ? 'realtime' : 'pipeline';
}

async function main(): Promise<void> {
  const assertBudget = process.argv.includes('--assert-budget');
  const live = process.argv.includes('--live');
  const tier = tierArg();
  if (!live) {
    const budgets =
      tier === 'realtime' ? VOICE_REALTIME_LATENCY_BUDGET_MS : VOICE_LATENCY_BUDGET_MS;
    console.log(
      `Budgets (${tier}): ${Object.entries(budgets)
        .map(([k, v]) => `${k} ≤${v}ms`)
        .join(' | ')}`,
    );
  }
  const run =
    tier === 'realtime' ? (live ? runLiveRealtime : runMockRealtime) : live ? runLive : runMock;
  const ok = await run(assertBudget);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
