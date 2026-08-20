// Minimal observability surface AgentLoop expects — defined locally so core
// does not import the concrete `EthosObservability` adapter (that lives in
// `@ethosagent/wiring`). Any object exposing this method shape is a fit;
// `EthosObservability` satisfies it structurally at the wiring boundary.

import type { EventSeverity, PersonalityObservabilityConfig, SpanKind } from '@ethosagent/types';

interface RecordEventOpts {
  traceId?: string;
  spanId?: string;
  code?: string;
  cause?: string;
  details?: Record<string, unknown>;
  severity?: EventSeverity;
}

export interface AgentLoopObservability {
  startTurnTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    snapshotId?: string;
    obsConfig?: PersonalityObservabilityConfig;
    attrs?: Record<string, unknown>;
  }): string;
  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void;
  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
    obsConfig?: PersonalityObservabilityConfig;
  }): string;
  endSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
  ): void;
  /** Optional — `EthosObservability` satisfies it; lighter adapters may not. */
  recordError?(opts: RecordEventOpts): void;
  recordSafetyBlock(opts: RecordEventOpts): void;
  recordCompaction(opts: RecordEventOpts): void;
  recordToolRepair?(
    opts: RecordEventOpts & { toolName: string; outcome: 'repaired' | 'failed' },
  ): void;
  recordTierEscalation(
    opts: RecordEventOpts & {
      from: string;
      to: string;
      reason: string;
      personalityId: string;
    },
  ): void;
  recordTierOverride(
    opts: RecordEventOpts & {
      actor: 'user' | 'framework';
      tier: string;
      personalityId: string;
    },
  ): void;
  /**
   * AN-C1 — a skill reached the model, and how.
   *
   * `invoked` is a deliberate `get_skill` call: the model asked for the body.
   * `exposed` is injection-mode presence — the skill sat in the prompt whether
   * the model used it or not. They are counted separately because they cost
   * differently and mean different things: exposure is a standing token bill
   * paid every turn, invocation is a choice the model made once. One combined
   * "skill used" number would hide which of the two you are paying for.
   *
   * `exposed` is deduped per turn by the caller: a skill in the prompt is there
   * for the whole turn, so one event per (turn, skill).
   *
   * Optional, like `recordToolRepair` — `EthosObservability` satisfies it,
   * lighter adapters need not.
   */
  recordSkillInvocation?(
    opts: RecordEventOpts & { skill: string; mode: 'invoked' | 'exposed' },
  ): void;
  /**
   * Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase D,
   * §6) — the live-assembled bytes for a context `kind` did not hash to what
   * the emit-on-change write path (Phase B) just confirmed for it. Should
   * never fire: it means a code path read around the log. Not a new
   * `AgentEvent` variant (frozen at 17, D8) and not `console.*` — this is the
   * generic "record an anomaly" mechanism the observability writer already
   * offers, the same one `recordSkillInvocation`/`recordToolRepair` use.
   *
   * Optional, like those two — `EthosObservability` satisfies it, lighter
   * adapters need not.
   */
  recordContextDrift?(
    opts: RecordEventOpts & { kind: string; expectedHash: string; actualHash: string },
  ): void;
  flush(): void;
}
