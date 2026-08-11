// EthosObservability — ethos's adapter onto the generic
// `@ethosagent/observability-sqlite` writer.
//
// Why this lives in `packages/wiring/`:
//   The library (`extensions/observability-sqlite/`) is vocabulary-agnostic
//   by design. Ethos vocabulary (event categories, trace kinds, the
//   personality-id↔subject-id mapping) lives in this thin adapter so the
//   library stays clean. Wiring is the integration layer: it constructs
//   ethos-specific things around generic primitives.
//
// Consumers (agent-loop, gateway, agent-mesh) accept their own minimal
// structural interface — never this concrete class — so individual
// packages don't pull in app vocabulary just to record events.
// EthosObservability satisfies those interfaces structurally at the
// wiring boundary.
//
// See: plan/phases/observability_extractability.md

import type {
  EventSeverity,
  ObsEvent,
  ObservabilityWriter,
  PersonalityObservabilityConfig,
  RedactionPolicy,
  SpanKind,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Ethos vocabulary — the only place these literals live in the codebase.
// Adding a new ethos event category MUST come with a corresponding typed
// helper below; the escape hatch (`recordEthosEvent`) is for one-offs only.
// ---------------------------------------------------------------------------

export const ETHOS_EVENT_CATEGORIES = [
  'error',
  'audit.transition',
  'audit.approval',
  'audit.block',
  'audit.watcher',
  'audit.injection_flag',
  'audit.redacted',
  'audit.compaction',
  'tool.repair',
  'channel.pairing',
  'channel.allow',
  'channel.deny',
  'install.scan',
  'install.event',
  'tier.escalation',
  'tier.override',
  'heartbeat.decision',
  'memory.pending_cap',
  'a2a.auth',
  'a2a.rpc',
  'a2a.task',
  'funnel.setup_completed',
  'funnel.first_reply',
  'funnel.channel_first_reply',
] as const;
export type EthosEventCategory = (typeof ETHOS_EVENT_CATEGORIES)[number];

export const ETHOS_TRACE_KINDS = [
  'turn',
  'mesh.handshake',
  'cron.tick',
  'channel.inbound',
  'system',
  'support.bundle',
] as const;
export type EthosTraceKind = (typeof ETHOS_TRACE_KINDS)[number];

// Frozen so callers that propagate the policy can't mutate the default
// out from under future calls.
const DEFAULT_REDACTION: Readonly<RedactionPolicy> = Object.freeze({ level: 'redacted' });

interface EventBase {
  traceId?: string;
  spanId?: string;
  code?: string;
  cause?: string;
  details?: Record<string, unknown>;
}

/**
 * Domain-friendly facade over ObservabilityWriter. Owns ethos vocabulary;
 * translates ethos types to generic types at the boundary; exposes typed
 * helpers for common ethos events so call sites read as domain actions
 * rather than infrastructure plumbing.
 */
export class EthosObservability {
  constructor(
    private readonly writer: ObservabilityWriter,
    private readonly defaultRedaction: RedactionPolicy = DEFAULT_REDACTION,
  ) {}

  // ── Boundary translation ────────────────────────────────────────────────

  /** Map an ethos personality observability config to the generic policy. */
  private redactionFor(obsConfig?: PersonalityObservabilityConfig): RedactionPolicy {
    if (!obsConfig) return this.defaultRedaction;
    return {
      level: obsConfig.storeToolArgs ?? this.defaultRedaction.level,
      extraPatterns: obsConfig.redactPatterns,
    };
  }

  // ── Trace helpers (ethos vocabulary) ────────────────────────────────────

  startTurnTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    snapshotId?: string;
    obsConfig?: PersonalityObservabilityConfig;
    attrs?: Record<string, unknown>;
  }): string {
    return this.writer.startTrace({
      sessionId: opts.sessionId,
      kind: 'turn',
      subjectId: opts.personalityId,
      snapshotId: opts.snapshotId,
      attrs: opts.attrs,
      redaction: this.redactionFor(opts.obsConfig),
    });
  }

  startMeshHandshakeTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    attrs?: Record<string, unknown>;
  }): string {
    return this.writer.startTrace({
      sessionId: opts.sessionId,
      kind: 'mesh.handshake',
      subjectId: opts.personalityId,
      attrs: opts.attrs,
    });
  }

  startCronTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    attrs?: Record<string, unknown>;
  }): string {
    return this.writer.startTrace({
      sessionId: opts.sessionId,
      kind: 'cron.tick',
      subjectId: opts.personalityId,
      attrs: opts.attrs,
    });
  }

  startChannelInboundTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    attrs?: Record<string, unknown>;
  }): string {
    return this.writer.startTrace({
      sessionId: opts.sessionId,
      kind: 'channel.inbound',
      subjectId: opts.personalityId,
      attrs: opts.attrs,
    });
  }

  /** One live voice turn: utterance committed → reply finished/interrupted. */
  startVoiceTurnTrace(opts: {
    sessionId?: string;
    personalityId?: string;
    attrs?: Record<string, unknown>;
  }): string {
    return this.writer.startTrace({
      sessionId: opts.sessionId,
      kind: 'voice.turn',
      subjectId: opts.personalityId,
      attrs: opts.attrs,
    });
  }

  startSystemTrace(opts: { attrs?: Record<string, unknown> } = {}): string {
    return this.writer.startTrace({ kind: 'system', attrs: opts.attrs });
  }

  startSupportBundleTrace(opts: { attrs?: Record<string, unknown> } = {}): string {
    return this.writer.startTrace({ kind: 'support.bundle', attrs: opts.attrs });
  }

  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    this.writer.endTrace(traceId, status);
  }

  // ── Span passthrough (ethos has no domain spans yet) ────────────────────

  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
    obsConfig?: PersonalityObservabilityConfig;
  }): string {
    return this.writer.startSpan({
      traceId: opts.traceId,
      parentSpanId: opts.parentSpanId,
      kind: opts.kind,
      name: opts.name,
      attrs: opts.attrs,
      redaction: opts.obsConfig ? this.redactionFor(opts.obsConfig) : undefined,
    });
  }

  endSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
  ): void {
    this.writer.endSpan(spanId, status, attrs);
  }

  flush(): void {
    this.writer.flush();
  }

  // ── Typed event helpers ────────────────────────────────────────────────
  //
  // All helpers below funnel through `emit`. Adding a new ethos category is
  // one line: add to ETHOS_EVENT_CATEGORIES, then a one-line method here.

  private emit(
    category: EthosEventCategory,
    defaultSeverity: EventSeverity,
    opts: EventBase & { severity?: EventSeverity },
    extraDetails?: Record<string, unknown>,
  ): void {
    this.writer.recordEvent({
      traceId: opts.traceId,
      spanId: opts.spanId,
      category,
      severity: opts.severity ?? defaultSeverity,
      code: opts.code,
      cause: opts.cause,
      details:
        extraDetails === undefined ? opts.details : { ...(opts.details ?? {}), ...extraDetails },
    });
  }

  recordError(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('error', 'error', opts);
  }

  recordSafetyTransition(opts: {
    sessionId?: string;
    fromPersonalityId: string;
    toPersonalityId: string;
    fromSnapshotId?: string;
    toSnapshotId?: string;
    trigger: string;
    traceId?: string;
  }): void {
    this.emit(
      'audit.transition',
      'info',
      { traceId: opts.traceId },
      {
        sessionId: opts.sessionId,
        fromPersonalityId: opts.fromPersonalityId,
        toPersonalityId: opts.toPersonalityId,
        fromSnapshotId: opts.fromSnapshotId,
        toSnapshotId: opts.toSnapshotId,
        trigger: opts.trigger,
      },
    );
  }

  recordSafetyApproval(
    opts: EventBase & { decision: 'approved' | 'denied' | 'auto'; severity?: EventSeverity },
  ): void {
    this.emit('audit.approval', 'info', opts, { decision: opts.decision });
  }

  recordSafetyBlock(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('audit.block', 'warn', opts);
  }

  recordWatcherDecision(
    opts: EventBase & {
      decision: 'pause' | 'force_approval' | 'terminate';
      severity?: EventSeverity;
    },
  ): void {
    const severity = opts.severity ?? (opts.decision === 'terminate' ? 'critical' : 'warn');
    this.emit('audit.watcher', severity, { ...opts, severity }, { decision: opts.decision });
  }

  recordInjectionFlag(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('audit.injection_flag', 'warn', opts);
  }

  recordRedacted(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('audit.redacted', 'info', opts);
  }

  recordCompaction(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('audit.compaction', 'info', opts);
  }

  recordToolRepair(
    opts: EventBase & {
      toolName: string;
      outcome: 'repaired' | 'failed';
      severity?: EventSeverity;
    },
  ): void {
    this.emit('tool.repair', 'info', opts, { toolName: opts.toolName, outcome: opts.outcome });
  }

  recordChannelPairing(opts: EventBase): void {
    this.emit('channel.pairing', 'info', opts);
  }

  recordChannelAllow(opts: EventBase): void {
    this.emit('channel.allow', 'info', opts);
  }

  recordChannelDeny(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('channel.deny', 'info', opts);
  }

  recordSkillScan(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('install.scan', 'info', opts);
  }

  recordInstallEvent(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('install.event', 'info', opts);
  }

  recordTierEscalation(
    opts: EventBase & {
      from: string;
      to: string;
      reason: string;
      personalityId: string;
    },
  ): void {
    this.emit('tier.escalation', 'info', opts, {
      from: opts.from,
      to: opts.to,
      reason: opts.reason,
      personalityId: opts.personalityId,
    });
  }

  recordTierOverride(
    opts: EventBase & {
      actor: 'user' | 'framework';
      tier: string;
      personalityId: string;
    },
  ): void {
    this.emit('tier.override', 'info', opts, {
      actor: opts.actor,
      tier: opts.tier,
      personalityId: opts.personalityId,
    });
  }

  recordHeartbeatDecision(
    opts: EventBase & {
      personalityId?: string;
      jobId: string;
      decision: 'escalate' | 'silent' | 'script-silent' | 'precheck-skip';
      delivered: boolean;
    },
  ): void {
    this.emit('heartbeat.decision', 'info', opts, {
      personalityId: opts.personalityId,
      jobId: opts.jobId,
      decision: opts.decision,
      delivered: opts.delivered,
    });
  }

  /** A pending-memory candidate was dropped because the per-scope queue hit its
   *  hard cap (memory-lifecycle L2 back-pressure — drops must be audible). */
  recordMemoryPendingCapDrop(opts: EventBase & { severity?: EventSeverity }): void {
    this.emit('memory.pending_cap', 'warn', opts);
  }

  // ── Funnel events (W4.1 — adoption funnel; local-only, never phone-home) ──
  //
  // Exempt from retention/pruning by construction: `retention.ts` prunes only
  // its enumerated category patterns, and `funnel.%` is intentionally not one
  // of them — one-shot install-lifecycle data, bytes in size, must survive so
  // `ethos doctor --funnel` works months later.

  recordFunnelSetupCompleted(
    opts: EventBase & {
      provider: string;
      channels: string[];
      wizardPath: 'tui' | 'web' | 'readline' | 'env';
    },
  ): void {
    this.emit('funnel.setup_completed', 'info', opts, {
      provider: opts.provider,
      channels: opts.channels,
      wizardPath: opts.wizardPath,
    });
  }

  recordFunnelFirstReply(opts: EventBase & { msSinceSetup?: number; legacy?: boolean }): void {
    this.emit('funnel.first_reply', 'info', opts, {
      ...(opts.msSinceSetup !== undefined ? { msSinceSetup: opts.msSinceSetup } : {}),
      ...(opts.legacy ? { legacy: true } : {}),
    });
  }

  recordFunnelChannelFirstReply(
    opts: EventBase & { platform: string; msSinceSetup?: number; legacy?: boolean },
  ): void {
    this.emit('funnel.channel_first_reply', 'info', opts, {
      platform: opts.platform,
      ...(opts.msSinceSetup !== undefined ? { msSinceSetup: opts.msSinceSetup } : {}),
      ...(opts.legacy ? { legacy: true } : {}),
    });
  }

  // ── Escape hatch ────────────────────────────────────────────────────────

  /**
   * For one-off events that don't deserve a typed helper. Recurring
   * categories should be promoted to a typed helper above.
   *
   * `category` is constrained to `EthosEventCategory` so a typo like
   * `'audit.tranistion'` fails typecheck.
   */
  recordEthosEvent(
    event: Omit<ObsEvent, 'eventId' | 'ts'> & { category: EthosEventCategory },
  ): void {
    this.writer.recordEvent(event);
  }
}
