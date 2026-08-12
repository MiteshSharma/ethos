import { describe, expect, it } from 'vitest';
import {
  percentile,
  summarizeLatency,
  turnLatenciesFromSpans,
  VOICE_LATENCY_BUDGET_MS,
} from '../latency-budget';
import type { VoiceTurnSpan } from '../span-writer';

// The budget table and the arithmetic that turns cumulative spans into
// stage-owned time. This is what the live bench reports against, so a mistake
// here is a bench that lies.

function span(
  turnId: string,
  stage: VoiceTurnSpan['stage'],
  startTs: number,
  endTs: number,
  extra: Partial<VoiceTurnSpan> = {},
): VoiceTurnSpan {
  return { turnId, stage, startTs, endTs, status: 'ok', ...extra };
}

/** One turn: STT done at +150, first sentence at +700, first audio at +900. */
function turnSpans(turnId: string, sttMs: number, sentenceMs: number, audioMs: number) {
  return [
    span(turnId, 'stt', 0, sttMs, { sttProvider: 'local-stt' }),
    span(turnId, 'llm_first_sentence', 0, sentenceMs),
    span(turnId, 'tts_first_audio', 0, audioMs, { ttsProvider: 'local-tts' }),
    span(turnId, 'turn', 0, audioMs + 400),
  ];
}

describe('turnLatenciesFromSpans', () => {
  it('differences the cumulative spans into stage-owned time', () => {
    const [turn] = turnLatenciesFromSpans(turnSpans('u1', 150, 700, 900), { u1: 250 });
    expect(turn?.stages).toEqual({
      endpoint: 250,
      stt: 150,
      llm_first_sentence: 550,
      tts_first_audio: 200,
      // Mouth to ear: endpoint + everything the turn spans covered.
      pipeline: 1_150,
    });
  });

  it('names the providers that actually served the turn', () => {
    const [turn] = turnLatenciesFromSpans(turnSpans('u1', 100, 500, 700));
    expect(turn?.sttProvider).toBe('local-stt');
    expect(turn?.ttsProvider).toBe('local-tts');
  });

  it('omits the pipeline total when nobody measured endpointing', () => {
    const [turn] = turnLatenciesFromSpans(turnSpans('u1', 100, 500, 700));
    expect(turn?.stages.pipeline).toBeUndefined();
    expect(turn?.stages.endpoint).toBeUndefined();
    expect(turn?.stages.tts_first_audio).toBe(200);
  });

  it('ignores failed and interrupted spans rather than counting them as latency', () => {
    const spans: VoiceTurnSpan[] = [
      span('u1', 'stt', 0, 5_000, { status: 'error', error: 'provider down' }),
      span('u1', 'turn', 0, 5_000, { status: 'error' }),
    ];
    const [turn] = turnLatenciesFromSpans(spans, { u1: 200 });
    expect(turn?.stages).toEqual({ endpoint: 200 });
  });

  it('clamps an inverted difference to zero instead of reporting negative latency', () => {
    const spans = [
      span('u1', 'stt', 0, 300),
      // A coarse clock can land the sentence span a hair before the STT span.
      span('u1', 'llm_first_sentence', 0, 299),
    ];
    const [turn] = turnLatenciesFromSpans(spans);
    expect(turn?.stages.llm_first_sentence).toBe(0);
  });

  it('separates turns that arrived in one flush', () => {
    const turns = turnLatenciesFromSpans(
      [...turnSpans('u1', 100, 500, 700), ...turnSpans('u2', 120, 600, 800)],
      { u1: 200, u2: 220 },
    );
    expect(turns.map((t) => t.turnId)).toEqual(['u1', 'u2']);
    expect(turns[1]?.stages.pipeline).toBe(1_020);
  });
});

describe('percentile', () => {
  it('reports a latency that actually happened (nearest rank, not interpolated)', () => {
    const values = [100, 200, 300, 400];
    expect(percentile(values, 50)).toBe(200);
    expect(percentile(values, 90)).toBe(400);
    expect(percentile(values, 99)).toBe(400);
  });

  it('handles a single sample and an empty one', () => {
    expect(percentile([42], 99)).toBe(42);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe('summarizeLatency', () => {
  it('passes when every stage p90 is inside its budget', () => {
    const turns = turnLatenciesFromSpans(
      [...turnSpans('u1', 150, 700, 900), ...turnSpans('u2', 160, 720, 950)],
      { u1: 250, u2: 260 },
    );
    const report = summarizeLatency(turns);
    expect(report.turns).toBe(2);
    expect(report.withinBudget).toBe(true);
    const stt = report.stages.find((s) => s.stage === 'stt');
    expect(stt?.budgetMs).toBe(VOICE_LATENCY_BUDGET_MS.stt);
    expect(stt?.p90).toBe(160);
  });

  it('fails on the tail, not the median — a fast median cannot rescue a slow p90', () => {
    const spans: VoiceTurnSpan[] = [];
    const endpoints: Record<string, number> = {};
    for (let i = 0; i < 8; i++) {
      spans.push(...turnSpans(`u${i}`, 100, 500, 700));
      endpoints[`u${i}`] = 200;
    }
    // Two turns where the model took four seconds to say anything.
    for (const id of ['slow1', 'slow2']) {
      spans.push(...turnSpans(id, 100, 4_000, 4_200));
      endpoints[id] = 200;
    }

    const report = summarizeLatency(turnLatenciesFromSpans(spans, endpoints));
    const llm = report.stages.find((s) => s.stage === 'llm_first_sentence');
    expect(llm?.p50).toBe(400);
    expect(llm?.p90).toBe(3_900);
    expect(llm?.withinBudget).toBe(false);
    expect(report.withinBudget).toBe(false);
  });

  it('reports only the stages that were actually measured', () => {
    const report = summarizeLatency(turnLatenciesFromSpans(turnSpans('u1', 100, 500, 700)));
    expect(report.stages.map((s) => s.stage)).toEqual([
      'stt',
      'llm_first_sentence',
      'tts_first_audio',
    ]);
  });

  it('holds the pipeline-tier budgets the plan committed to', () => {
    expect(VOICE_LATENCY_BUDGET_MS).toEqual({
      endpoint: 300,
      stt: 200,
      llm_first_sentence: 800,
      tts_first_audio: 300,
      pipeline: 1_600,
    });
  });
});
