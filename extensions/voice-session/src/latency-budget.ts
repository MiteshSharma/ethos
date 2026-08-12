// The voice latency contract, expressed against the spans a real turn writes.
//
// The per-stage spans (`span-writer.ts`) are cumulative from the start of the
// turn — `llm_first_sentence` includes the STT that preceded it, and
// `tts_first_audio` includes both. That is the right shape for attribution ("a
// lost reply is attributable to a stage") and the wrong shape for a budget
// table, where each stage should own only its own time. Differencing them is
// the whole job of this module, and it lives here rather than in the bench
// script because `scripts/` is outside the test globs — a budget nobody can
// test is a budget that quietly stops being true.

import type { VoiceTurnSpan } from './span-writer';

export type VoiceLatencyStage =
  /** Last speech frame → the utterance being committed. Endpoint detection. */
  | 'endpoint'
  /** Committed audio → final transcript. */
  | 'stt'
  /** Transcript → the first sentence handed to synthesis. */
  | 'llm_first_sentence'
  /** First sentence → the first audio frame out. */
  | 'tts_first_audio'
  /** Endpoint → first audio. Mouth to ear, the number the user feels. */
  | 'pipeline';

export const VOICE_LATENCY_STAGES: readonly VoiceLatencyStage[] = [
  'endpoint',
  'stt',
  'llm_first_sentence',
  'tts_first_audio',
  'pipeline',
];

/** Pipeline-tier budgets (voice V1a latency contract). */
export const VOICE_LATENCY_BUDGET_MS: Record<VoiceLatencyStage, number> = {
  endpoint: 300,
  stt: 200,
  llm_first_sentence: 800,
  tts_first_audio: 300,
  pipeline: 1_600,
};

/** One turn's stage timings. A stage is absent when its span never landed. */
export interface VoiceTurnLatency {
  turnId: string;
  /** The providers that actually served this turn, when the spans named them. */
  sttProvider?: string;
  ttsProvider?: string;
  stages: Partial<Record<VoiceLatencyStage, number>>;
}

export interface StagePercentiles {
  stage: VoiceLatencyStage;
  count: number;
  p50: number;
  p90: number;
  p99: number;
  budgetMs: number;
  /** Budgets are checked against p90: a tail that misses is a miss. */
  withinBudget: boolean;
}

export interface VoiceLatencyReport {
  turns: number;
  stages: StagePercentiles[];
  /** True when every measured stage's p90 is inside its budget. */
  withinBudget: boolean;
}

/**
 * Nearest-rank percentile over a sample. Nearest-rank (not interpolated)
 * because every reported number is then a latency that actually happened —
 * an interpolated p99 is a number no turn ever took.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? Number.NaN;
}

/**
 * Turn the cumulative spans of one or more turns into per-stage durations.
 *
 * `endpointMsByTurn` supplies the one stage no span covers: endpointing happens
 * BEFORE the turn exists, so only the caller driving the audio knows when the
 * user stopped talking. Turns with no entry simply have no endpoint stage, and
 * no pipeline total — a made-up zero would flatter the number that matters most.
 */
export function turnLatenciesFromSpans(
  spans: readonly VoiceTurnSpan[],
  endpointMsByTurn: Readonly<Record<string, number>> = {},
): VoiceTurnLatency[] {
  const byTurn = new Map<string, VoiceTurnSpan[]>();
  for (const span of spans) {
    const list = byTurn.get(span.turnId);
    if (list) list.push(span);
    else byTurn.set(span.turnId, [span]);
  }

  const out: VoiceTurnLatency[] = [];
  for (const [turnId, turnSpans] of byTurn) {
    const ok = turnSpans.filter((s) => s.status === 'ok');
    const duration = (stage: VoiceTurnSpan['stage']): number | undefined => {
      const span = ok.find((s) => s.stage === stage);
      return span ? span.endTs - span.startTs : undefined;
    };

    const sttMs = duration('stt');
    const toSentence = duration('llm_first_sentence');
    const toAudio = duration('tts_first_audio');
    const endpointMs = endpointMsByTurn[turnId];

    const stages: Partial<Record<VoiceLatencyStage, number>> = {};
    if (endpointMs !== undefined) stages.endpoint = endpointMs;
    if (sttMs !== undefined) stages.stt = sttMs;
    // Cumulative spans differenced into stage-owned time. Clamped at zero: two
    // spans a fraction of a millisecond apart can invert under a coarse clock,
    // and a negative latency is noise, not a finding.
    if (toSentence !== undefined) {
      stages.llm_first_sentence = Math.max(0, toSentence - (sttMs ?? 0));
    }
    if (toAudio !== undefined) {
      stages.tts_first_audio = Math.max(0, toAudio - (toSentence ?? sttMs ?? 0));
    }
    if (toAudio !== undefined && endpointMs !== undefined) {
      stages.pipeline = endpointMs + toAudio;
    }

    const sttProvider = turnSpans.find((s) => s.sttProvider)?.sttProvider;
    const ttsProvider = turnSpans.find((s) => s.ttsProvider)?.ttsProvider;
    out.push({
      turnId,
      ...(sttProvider ? { sttProvider } : {}),
      ...(ttsProvider ? { ttsProvider } : {}),
      stages,
    });
  }
  return out;
}

/** Percentile summary per stage, with the budget verdict. */
export function summarizeLatency(turns: readonly VoiceTurnLatency[]): VoiceLatencyReport {
  const stages: StagePercentiles[] = [];
  for (const stage of VOICE_LATENCY_STAGES) {
    const values = turns
      .map((t) => t.stages[stage])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const budgetMs = VOICE_LATENCY_BUDGET_MS[stage];
    const p90 = percentile(values, 90);
    stages.push({
      stage,
      count: values.length,
      p50: percentile(values, 50),
      p90,
      p99: percentile(values, 99),
      budgetMs,
      withinBudget: p90 <= budgetMs,
    });
  }
  return {
    turns: turns.length,
    stages,
    withinBudget: stages.every((s) => s.withinBudget),
  };
}
