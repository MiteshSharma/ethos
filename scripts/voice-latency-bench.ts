// Voice pipeline latency harness.
//
//   pnpm tsx scripts/voice-latency-bench.ts [--assert-budget] \
//     [--endpoint-ms=N] [--llm-ms=N] [--tts-ms=N]
//
// Drives a real VoiceSession with synthetic PCM and MOCK providers that inject
// configurable per-stage latency, then measures the §3(c) latency budget:
//   endpoint ≤ 400ms | LLM-to-first-sentence ≤ 1400ms | TTS first chunk ≤ 400ms
//   | total utterance-end -> first-audio ≤ 2500ms
//
// With --assert-budget the process exits non-zero if the measured total
// exceeds its budget. Defaults are set to pass comfortably — a regression
// baseline, and proof the assertion machinery works.
//
// scripts/ is tooling (like apps/ethos), so console.* is allowed here.

import type {
  AgentEvent,
  PcmChunk,
  StreamingSttProvider,
  StreamingTtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import {
  type AgentTurnRunner,
  VoiceSession,
  type VoiceSessionEvent,
} from '@ethosagent/voice-session';

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

interface StageResult {
  stage: string;
  measuredMs: number;
  budgetMs: number;
}

async function main(): Promise<void> {
  const endpointMs = arg('endpoint-ms', 200);
  const llmMs = arg('llm-ms', 900);
  const ttsMs = arg('tts-ms', 200);
  const assertBudget = process.argv.includes('--assert-budget');

  // Fake clock so endpoint detection commits deterministically (no real-time
  // silence wait); provider stage delays are real wall-clock.
  let clockT = 0;
  const now = () => clockT;

  const session = new VoiceSession({
    runner: mockRunner(llmMs),
    stt: mockStt(endpointMs),
    tts: mockTts(ttsMs),
    vad: new MarkerVad(),
    now,
    config: { endpointSilenceMs: 350 },
  });

  const marks: Partial<Record<VoiceSessionEvent['type'], number>> = {};
  session.on((e) => {
    if (marks[e.type] === undefined) marks[e.type] = performance.now();
  });

  // Feed a synthetic utterance: speech then trailing silence to trigger endpointing.
  for (let i = 0; i < 5; i++) {
    clockT += 20;
    session.pushAudio(speechFrame());
  }
  for (let i = 0; i < 30; i++) {
    clockT += 20;
    session.pushAudio(silenceFrame());
  }
  const tCommit = performance.now();

  await session.idle();

  const committed = marks.utterance_committed ?? tCommit;
  const sentence = marks.reply_sentence ?? committed;
  const audio = marks.reply_audio ?? sentence;

  const stages: StageResult[] = [
    { stage: 'Endpoint + STT final', measuredMs: committed - tCommit, budgetMs: 400 },
    { stage: 'LLM to first sentence', measuredMs: sentence - committed, budgetMs: 1400 },
    { stage: 'TTS first chunk', measuredMs: audio - sentence, budgetMs: 400 },
  ];
  const totalMs = audio - tCommit;
  const totalBudget = 2500;

  printTable(stages, totalMs, totalBudget);

  if (assertBudget && totalMs > totalBudget) {
    console.error(`\nFAIL: total ${totalMs.toFixed(0)}ms exceeds budget ${totalBudget}ms.`);
    process.exit(1);
  }
  if (assertBudget) {
    console.log(`\nPASS: total ${totalMs.toFixed(0)}ms within budget ${totalBudget}ms.`);
  }
}

function printTable(stages: StageResult[], totalMs: number, totalBudget: number): void {
  const rows = [
    ...stages.map((s) => ({
      stage: s.stage,
      measured: `${s.measuredMs.toFixed(0)}ms`,
      budget: `≤ ${s.budgetMs}ms`,
      ok: s.measuredMs <= s.budgetMs ? 'PASS' : 'FAIL',
    })),
    {
      stage: 'TOTAL (utterance-end → first-audio)',
      measured: `${totalMs.toFixed(0)}ms`,
      budget: `≤ ${totalBudget}ms`,
      ok: totalMs <= totalBudget ? 'PASS' : 'FAIL',
    },
  ];

  const w0 = Math.max(...rows.map((r) => r.stage.length), 'Stage'.length);
  const w1 = Math.max(...rows.map((r) => r.measured.length), 'Measured'.length);
  const w2 = Math.max(...rows.map((r) => r.budget.length), 'Budget'.length);
  const pad = (s: string, w: number) => s.padEnd(w);

  console.log('\nVoice pipeline latency budget\n');
  console.log(`  ${pad('Stage', w0)}  ${pad('Measured', w1)}  ${pad('Budget', w2)}  Result`);
  console.log(`  ${'-'.repeat(w0)}  ${'-'.repeat(w1)}  ${'-'.repeat(w2)}  ------`);
  for (const r of rows) {
    console.log(`  ${pad(r.stage, w0)}  ${pad(r.measured, w1)}  ${pad(r.budget, w2)}  ${r.ok}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
