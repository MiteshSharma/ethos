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
  flush(): void;
}
