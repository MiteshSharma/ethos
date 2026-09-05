// MemoryCaptureRunner (§3) — owns the post-turn capture queue.
//
// Trigger → Extraction → Write, with all §3.2 guards. The runner is pure and
// injectable: wiring hands it a MemoryProvider (undecorated — the runner records
// its own history entry so it can carry `hint`/`captureHashes`), a HistoryStore,
// a SessionStore (to resolve sessionKey off the hot path), an auxiliary
// LLMProvider, and a content-sanitizer. The ONLY per-process state is the
// in-memory in-flight flag; every rate-limit / dedup fact is derived from the
// append-only history (§3.2), so nothing races across processes.

import type { HistoryStore } from '@ethosagent/memory-history';
import type {
  AgentDonePayload,
  HookRegistry,
  LLMProvider,
  Logger,
  MemoryContext,
  MemoryProvider,
  MemoryUpdate,
  SessionStore,
} from '@ethosagent/types';
import { hashFact } from './dedup';
import { evaluateEligibility } from './eligibility';
import { extractFacts } from './extraction';
import {
  type CaptureConfig,
  type CaptureFact,
  type CaptureJob,
  type CaptureNotice,
  DEFAULT_CAPTURE_CONFIG,
  type GroundingConsult,
  type ProposeFn,
  type TombstoneChecker,
} from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Injected inline-consolidation pass (§3.5). Runs only when no macro-loop exists. */
export type ConsolidateFn = (args: { scopeId: string; ctx: MemoryContext }) => Promise<void>;

export interface MemoryCaptureRunnerOptions {
  /** Undecorated write provider — the runner records history itself (§2.1 hint). */
  provider: MemoryProvider;
  history: HistoryStore;
  session: SessionStore;
  /** Auxiliary model for the single extraction call per eligible turn. */
  llm: LLMProvider;
  /** Same content-safety sanitize `memory_write` applies (`tools-memory`). */
  sanitize: (content: string) => string;
  logger: Logger;
  config?: Partial<CaptureConfig>;
  /** When true, a macro-loop (nightly/dream) exists — never inline-consolidate. */
  nightlyConfigured: boolean;
  /** Injected inline consolidation; omitted when unavailable. */
  consolidate?: ConsolidateFn;
  /**
   * Approve-before-store gate (memory-lifecycle L2). When present, capture
   * PROPOSES each fresh fact to the pending queue instead of writing it durably;
   * the fact only reaches memory once approved. When absent, capture writes
   * directly (add-only) as before.
   */
  propose?: ProposeFn;
  /**
   * Reject-tombstone reader (L2). Facts whose hash is tombstoned are dropped
   * before proposal/write so a rejected fact is never re-proposed. Consulted
   * regardless of `propose`, so a fact rejected while gating was on stays
   * rejected even after approval is later disabled.
   */
  tombstones?: TombstoneChecker;
  /**
   * Ground-truth consult (R8). Omitted → capture behaves exactly as it did
   * before the seam existed; see `GroundingConsult` for why it is a port and
   * not an import.
   */
  grounding?: GroundingConsult;
  /** Stamped into the MemoryContext; routing ignores it, kept for contract shape. */
  platform?: string;
  workingDir?: string;
  /** Test seam. */
  now?: () => number;
}

export class MemoryCaptureRunner {
  private readonly opts: MemoryCaptureRunnerOptions;
  private readonly config: CaptureConfig;
  private readonly now: () => number;
  private readonly queue: CaptureJob[] = [];
  /** The ONLY per-process state: scopes with a capture in flight. */
  private readonly inFlight = new Set<string>();
  private readonly captureListeners: Array<(n: CaptureNotice) => void> = [];
  private draining = false;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(opts: MemoryCaptureRunnerOptions) {
    this.opts = opts;
    this.config = { ...DEFAULT_CAPTURE_CONFIG, ...opts.config };
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Register the `agent_done` void-hook handler. CRITICAL: `fireVoid` is
   * awaited BEFORE the `done` event yields, so the handler only enqueues and
   * returns — never runs the LLM inline. Returns the `registerVoid` cleanup.
   */
  registerHook(hooks: HookRegistry): () => void {
    return hooks.registerVoid('agent_done', async (payload: AgentDonePayload) => {
      if (!payload.personalityId) return;
      const job: CaptureJob = {
        sessionId: payload.sessionId,
        personalityId: payload.personalityId,
        text: payload.text,
        initialPrompt: payload.initialPrompt ?? '',
        // The frozen payload carries no dry-run flag; wiring cannot observe it.
        isDryRun: false,
      };
      if (await this.contradicted(job)) {
        // R8: memory must not quietly record "I did a good job" from a turn
        // whose own tools say otherwise. Skip, or mark and keep.
        if (!this.opts.grounding?.tag) return;
        job.unverified = true;
      }
      this.enqueue(job);
    });
  }

  /**
   * Ask the grounding seam whether this turn contradicted its own evidence.
   *
   * Fail OPEN, like every other guard in this module (§0 void-hook model): a
   * consult that throws must not silently switch memory off. The cost of the
   * wrong answer here is one possibly-wrong fact, which consolidation can
   * distill later; the cost of the other direction is a user who stops being
   * remembered and is never told why.
   */
  private async contradicted(job: CaptureJob): Promise<boolean> {
    const grounding = this.opts.grounding;
    if (!grounding) return false;
    try {
      return await grounding.contradicted(job);
    } catch (err) {
      this.opts.logger.warn('memory-capture: grounding consult failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Subscribe to capture notices (§3.3). Returns an unsubscribe fn. */
  onCaptured(cb: (n: CaptureNotice) => void): () => void {
    this.captureListeners.push(cb);
    return () => {
      const i = this.captureListeners.indexOf(cb);
      if (i >= 0) this.captureListeners.splice(i, 1);
    };
  }

  /** Resolves when the queue has fully drained. Test/shutdown aid. */
  whenIdle(): Promise<void> {
    return this.idlePromise;
  }

  /** Enqueue a job and return immediately (<1ms — the hot-path contract). */
  enqueue(job: CaptureJob): void {
    this.queue.push(job);
    if (!this.draining) {
      this.idlePromise = new Promise((resolve) => {
        this.resolveIdle = resolve;
      });
      this.draining = true;
      // Kick the drain without awaiting — the LLM call lands well after `done`.
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        try {
          await this.process(job);
        } catch (err) {
          // Fail-open: capture is a best-effort side effect (§0 void-hook model).
          this.opts.logger.warn('memory-capture: job failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdle?.();
      this.resolveIdle = null;
    }
  }

  private async process(job: CaptureJob): Promise<void> {
    // Resolve sessionKey off the hot path (the frozen payload lacks it).
    const session = await this.opts.session.getSession(job.sessionId);
    const sessionKey = session?.key ?? '';

    const eligibility = evaluateEligibility({
      sessionKey,
      initialPrompt: job.initialPrompt,
      finalText: job.text,
      isDryRun: job.isDryRun,
      minUserChars: this.config.minUserChars,
    });
    if (!eligibility.eligible) return;

    // Scope is the turn's OWN personality scope — the runner constructs it and
    // can therefore never address any other scope (§3.1).
    const scopeId = `personality:${job.personalityId}`;
    if (this.inFlight.has(scopeId)) return;
    this.inFlight.add(scopeId);
    try {
      const ctx: MemoryContext = {
        scopeId,
        sessionId: job.sessionId,
        sessionKey,
        platform: this.opts.platform ?? 'cli',
        workingDir: this.opts.workingDir ?? '',
      };

      if (await this.rateLimited(scopeId)) return;

      const facts = await extractFacts(
        { initialPrompt: job.initialPrompt, finalText: job.text },
        this.opts.llm,
      );
      if (facts.length === 0) return;

      const fresh = await this.dedup(scopeId, facts);
      if (fresh.length === 0) return;

      const unverified = job.unverified === true;
      if (this.opts.propose) {
        // L2: the approval gate is active — park each fact instead of writing.
        // No durable write, no history entry, no "remembered" notice: nothing
        // was remembered yet. Approval replays it through the history path.
        await this.propose(ctx, fresh, unverified);
        return;
      }

      await this.write(ctx, fresh, unverified);
      await this.maybeConsolidate(ctx);
    } finally {
      this.inFlight.delete(scopeId);
    }
  }

  /** Rate cap counted from recent `capture` history entries (§3.2). */
  private async rateLimited(scopeId: string): Promise<boolean> {
    const now = this.now();
    const { entries } = await this.opts.history.read(scopeId, {
      source: 'capture',
      sinceMs: now - DAY_MS,
    });
    const dayCount = entries.length;
    const hourCount = entries.filter((e) => e.ts >= now - HOUR_MS).length;
    return dayCount >= this.config.maxPerDay || hourCount >= this.config.maxPerHour;
  }

  /** Drop facts whose normalized hash already appears in the recent history. */
  private async dedup(scopeId: string, facts: CaptureFact[]): Promise<CaptureFact[]> {
    const now = this.now();
    const { entries } = await this.opts.history.read(scopeId, {
      source: 'capture',
      sinceMs: now - this.config.dedupWindowMs,
    });
    const seen = new Set<string>();
    for (const e of entries) for (const h of e.captureHashes ?? []) seen.add(h);

    const fresh: CaptureFact[] = [];
    for (const fact of facts) {
      const h = hashFact(fact.text);
      if (seen.has(h)) continue;
      seen.add(h); // also dedup within this batch
      // L2: a rejected/expired fact is tombstoned — never re-propose it.
      if (await this.opts.tombstones?.has(scopeId, h)) continue;
      fresh.push(fact);
    }
    return fresh;
  }

  /**
   * L2 propose path: park each fact as its own single-add candidate so the
   * queue entry carries the EXACT `hashFact(fact.text)` — the tombstone key used
   * on reject. One proposal per fact keeps the hash 1:1 with the parked update.
   */
  private async propose(
    ctx: MemoryContext,
    facts: CaptureFact[],
    unverified: boolean,
  ): Promise<void> {
    const proposeFn = this.opts.propose;
    if (!proposeFn) return;
    for (const fact of facts) {
      const key = fact.store === 'memory' ? 'MEMORY.md' : 'USER.md';
      const content = `\n${this.line(fact, unverified)}`;
      await proposeFn({
        scopeId: ctx.scopeId,
        update: { action: 'add', key, content },
        source: 'capture',
        factHash: hashFact(fact.text),
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
      });
    }
  }

  /**
   * The durable line for one fact.
   *
   * A tagged capture carries the marker INLINE, because the memory file is the
   * only place a later reader — human or model — will ever look; a boolean on
   * a queue object nobody reads back would be the decoration this feature
   * exists to avoid. The fact TEXT is unchanged, so `hashFact` still sees the
   * same string and dedup, tombstones and re-capture are untouched by tagging.
   */
  private line(fact: CaptureFact, unverified: boolean): string {
    const text = this.opts.sanitize(fact.text);
    return unverified ? `- ${text} (unverified)` : `- ${text}`;
  }

  /** Add-only write, one history entry per key with hint + capture hashes. */
  private async write(
    ctx: MemoryContext,
    facts: CaptureFact[],
    unverified: boolean,
  ): Promise<void> {
    const byStore = new Map<'memory' | 'user', CaptureFact[]>();
    for (const f of facts) {
      const list = byStore.get(f.store) ?? [];
      list.push(f);
      byStore.set(f.store, list);
    }

    for (const [store, group] of byStore) {
      const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
      const appendText = group.map((f) => this.line(f, unverified)).join('\n');
      const content = `\n${appendText}`;

      const before = (await this.opts.provider.read(key, ctx))?.content ?? '';
      // Capture is ADD-ONLY (§3): it never replaces or removes durable memory —
      // a bad extraction can add noise, consolidation later distills it. The
      // narrowed element type makes any future `replace`/`remove`/`delete` here
      // a compile error, not just a runtime convention.
      const updates: Array<Extract<MemoryUpdate, { action: 'add' }>> = [
        { action: 'add', key, content },
      ];
      // Durable write FIRST, history record AFTER — fail-open per invariant #7.
      // A crash between the two leaves the appended fact durable with no history
      // entry (before-state unrecoverable for that mutation); capture is a
      // best-effort side effect, so this window is accepted, not guarded.
      await this.opts.provider.sync(updates, ctx);
      const after = (await this.opts.provider.read(key, ctx))?.content ?? '';

      await this.opts.history.record({
        scopeId: ctx.scopeId,
        key,
        actions: ['add'],
        source: 'capture',
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        before,
        after,
        hint: Math.max(...group.map((f) => f.hint)),
        captureHashes: group.map((f) => hashFact(f.text)),
      });
    }

    const summary = facts.map((f) => f.text).join('; ');
    for (const cb of this.captureListeners) {
      try {
        cb({ scopeId: ctx.scopeId, sessionId: ctx.sessionId, summary });
      } catch {
        // A misbehaving surface listener must not break capture.
      }
    }
  }

  /**
   * Inline consolidation fallback (§3.5). Fires at most once per capture, only
   * when no macro-loop is configured AND the scope has crossed a size/count
   * threshold — so the zero-config CLI path degrades to "consolidate
   * occasionally" instead of silently evicting durable facts.
   */
  private async maybeConsolidate(ctx: MemoryContext): Promise<void> {
    if (this.opts.nightlyConfigured || !this.opts.consolidate) return;

    const memory = (await this.opts.provider.read('MEMORY.md', ctx))?.content ?? '';
    const overSize = Buffer.byteLength(memory) > this.config.consolidationSizeThreshold;

    let overCount = false;
    if (!overSize) {
      const { entries } = await this.opts.history.read(ctx.scopeId);
      let lastConsolidationTs = 0;
      for (const e of entries)
        if (e.source === 'consolidation' && e.ts > lastConsolidationTs) lastConsolidationTs = e.ts;
      const capturesSince = entries.filter(
        (e) => e.source === 'capture' && e.ts > lastConsolidationTs,
      ).length;
      overCount = capturesSince > this.config.consolidationCountThreshold;
    }

    if (!overSize && !overCount) return;
    await this.opts.consolidate({ scopeId: ctx.scopeId, ctx });
  }
}
