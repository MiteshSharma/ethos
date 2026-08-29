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

export type VoicePipelineLatencyStage =
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

/**
 * The realtime tier's stages.
 *
 * `endpoint` and `pipeline` mean exactly what they mean on the pipeline tier —
 * "how long after you stopped talking" and "mouth to ear" — so they keep their
 * names rather than acquiring realtime-flavoured synonyms. The three stages
 * between them do not exist here: one hosted session owns hearing, thinking and
 * speaking, and it reports one moment (its first audio frame), not three.
 */
export type VoiceRealtimeLatencyStage = 'endpoint' | 'realtime_first_audio' | 'pipeline';

export type VoiceLatencyStage = VoicePipelineLatencyStage | VoiceRealtimeLatencyStage;

/** Which tier a report is measured against. Picks the budget table. */
export type VoiceLatencyTier = 'pipeline' | 'realtime';

export const VOICE_LATENCY_STAGES: readonly VoicePipelineLatencyStage[] = [
  'endpoint',
  'stt',
  'llm_first_sentence',
  'tts_first_audio',
  'pipeline',
];

export const VOICE_REALTIME_LATENCY_STAGES: readonly VoiceRealtimeLatencyStage[] = [
  'endpoint',
  'realtime_first_audio',
  'pipeline',
];

/** Pipeline-tier budgets (voice V1a latency contract). */
export const VOICE_LATENCY_BUDGET_MS: Record<VoicePipelineLatencyStage, number> = {
  endpoint: 300,
  stt: 200,
  llm_first_sentence: 800,
  tts_first_audio: 300,
  pipeline: 1_600,
};

/**
 * Realtime-tier budgets (voice V1b latency contract).
 *
 * `pipeline: 800` is the plan's number — the whole reason the tier exists — and
 * it is the ONLY one measured directly here: the tier reports one moment (its
 * first audio frame), so mouth-to-ear is a measurement and the two stages
 * beneath it are an attribution of it.
 *
 * `endpoint: 300` is the same figure the pipeline tier carries, because it is
 * the same human fact: you cannot know someone stopped talking faster than you
 * are willing to wait. It inherits V1a's honesty note and extends it — on this
 * tier the silence threshold belongs to the PROVIDER's own server VAD (500 ms
 * by default on OpenAI Realtime), which no deployment-side setting can shorten,
 * so a live realtime bench will normally MISS this budget while making the
 * total. The number is printed, not moved to fit.
 *
 * `realtime_first_audio: 500` is what is left for the hosted session to think
 * and start speaking. It is only separable when the provider marks the commit
 * (its final user transcript) BEFORE its first audio — several providers
 * transcribe asynchronously and do not — and when it does not, the endpointing
 * is inside this stage and it reads high. The bench reports which case it saw.
 */
export const VOICE_REALTIME_LATENCY_BUDGET_MS: Record<VoiceRealtimeLatencyStage, number> = {
  endpoint: 300,
  realtime_first_audio: 500,
  pipeline: 800,
};

const BUDGETS: Record<VoiceLatencyTier, Partial<Record<VoiceLatencyStage, number>>> = {
  pipeline: VOICE_LATENCY_BUDGET_MS,
  realtime: VOICE_REALTIME_LATENCY_BUDGET_MS,
};

const STAGES: Record<VoiceLatencyTier, readonly VoiceLatencyStage[]> = {
  pipeline: VOICE_LATENCY_STAGES,
  realtime: VOICE_REALTIME_LATENCY_STAGES,
};

/** One turn's stage timings. A stage is absent when its span never landed. */
export interface VoiceTurnLatency {
  turnId: string;
  /** The providers that actually served this turn, when the spans named them. */
  sttProvider?: string;
  ttsProvider?: string;
  /** The hosted realtime provider that served this turn, on that tier. */
  realtimeProvider?: string;
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
  /** Which tier's budget table the stages were checked against. */
  tier: VoiceLatencyTier;
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
 *
 * On the REALTIME tier the same argument holds one step further out: the
 * provider owns the VAD and does not report when it decided, so the caller
 * supplies whatever commit marker it observed (or nothing) and the mouth-to-ear
 * total comes from the span itself.
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
    // The realtime tier's one stage. Cumulative from turn start like the rest,
    // so the mouth-to-ear total is computed the same way on both tiers.
    const toRealtimeAudio = duration('realtime_first_audio');
    const endpointMs = endpointMsByTurn[turnId];

    const stages: Partial<Record<VoiceLatencyStage, number>> = {};
    if (endpointMs !== undefined) stages.endpoint = endpointMs;
    if (sttMs !== undefined) stages.stt = sttMs;
    if (toRealtimeAudio !== undefined) stages.realtime_first_audio = toRealtimeAudio;
    // Cumulative spans differenced into stage-owned time. Clamped at zero: two
    // spans a fraction of a millisecond apart can invert under a coarse clock,
    // and a negative latency is noise, not a finding. (The realtime stage is
    // differenced the same way, below.)
    if (toSentence !== undefined) {
      stages.llm_first_sentence = Math.max(0, toSentence - (sttMs ?? 0));
    }
    if (toAudio !== undefined) {
      stages.tts_first_audio = Math.max(0, toAudio - (toSentence ?? sttMs ?? 0));
    }
    if (toRealtimeAudio !== undefined) {
      // The realtime span is cumulative from the moment the user stopped
      // talking — the only turn-start this tier gives a caller — so it IS
      // mouth-to-ear, and the provider's own leg is what remains after the
      // commit marker the caller supplied as `endpoint`. With no marker the
      // endpointing is INSIDE this number, which is why the bench says so
      // rather than reporting a zero endpoint.
      stages.pipeline = toRealtimeAudio;
      stages.realtime_first_audio = Math.max(0, toRealtimeAudio - (endpointMs ?? 0));
    } else if (toAudio !== undefined && endpointMs !== undefined) {
      stages.pipeline = endpointMs + toAudio;
    }

    const sttProvider = turnSpans.find((s) => s.sttProvider)?.sttProvider;
    const ttsProvider = turnSpans.find((s) => s.ttsProvider)?.ttsProvider;
    const realtimeProvider = turnSpans.find((s) => s.realtimeProvider)?.realtimeProvider;
    out.push({
      turnId,
      ...(sttProvider ? { sttProvider } : {}),
      ...(ttsProvider ? { ttsProvider } : {}),
      ...(realtimeProvider ? { realtimeProvider } : {}),
      stages,
    });
  }
  return out;
}

/**
 * Percentile summary per stage, with the budget verdict.
 *
 * `tier` picks the budget table and the stage list; the measurements themselves
 * are tier-agnostic, which is why there is one summarizer and not two.
 */
export function summarizeLatency(
  turns: readonly VoiceTurnLatency[],
  tier: VoiceLatencyTier = 'pipeline',
): VoiceLatencyReport {
  const stages: StagePercentiles[] = [];
  for (const stage of STAGES[tier]) {
    const values = turns
      .map((t) => t.stages[stage])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const budgetMs = BUDGETS[tier][stage];
    if (budgetMs === undefined) continue;
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
    tier,
    stages,
    withinBudget: stages.every((s) => s.withinBudget),
  };
}
