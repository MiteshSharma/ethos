// AgentBridge — adapt AgentLoop's async-generator stream into an EventEmitter
// surface every UI surface (TUI, web, VS Code) can subscribe to identically.
//
// Per Phase 26 eng-review:
//   • finding 1.3 — concurrent sends are queued (FIFO, cap 10), not silently
//     dropped. Emits `queued` when held; `error: BUSY` when cap hit.

import { EventEmitter } from 'node:events';
import type {
  AgentLoop,
  ClarifyPresenter,
  ClarifyResolvedListener,
  DryRunToolPlan,
  RunOptions,
} from '@ethosagent/core';
import type { ClarifySurfaceType } from '@ethosagent/types';
import { InMemorySteerSink } from './in-memory-steer-sink';

export type BridgeOpts = Omit<RunOptions, 'abortSignal'>;

export interface BridgeOptions {
  /** Max concurrent-send queue depth before new sends are rejected with BUSY. */
  queueCap?: number;
  /** Text buffer flush cadence in ms (default 16, ~60fps). */
  flushIntervalMs?: number;
  /** Max ms to wait for a turn to complete before emitting TIMEOUT (default 5 min). */
  turnTimeoutMs?: number;
}

interface BridgeEventMap {
  text_delta: [text: string];
  thinking_delta: [thinking: string];
  // Lane E (tools-as-code-api) — the trailing `audience` mirrors the optional
  // AgentEvent field: 'internal' marks in-script inner calls that user-facing
  // consumers must not render. Trailing/optional so 3-arg handlers keep working.
  tool_start: [
    toolCallId: string,
    toolName: string,
    args: unknown,
    audience: 'internal' | 'user' | 'dashboard' | undefined,
  ];
  tool_progress: [toolName: string, message: string, percent: number | undefined];
  tool_end: [
    toolCallId: string,
    toolName: string,
    ok: boolean,
    durationMs: number,
    result: string | undefined,
    structured: Record<string, unknown> | undefined,
    audience: 'internal' | 'user' | 'dashboard' | undefined,
  ];
  usage: [inputTokens: number, outputTokens: number, estimatedCostUsd: number];
  error: [error: string, code: string];
  // B3 — the trailing `traceId` mirrors the optional AgentEvent field: the
  // turn's observability trace id, or undefined when no adapter is wired.
  // Trailing/optional so existing 2-arg handlers keep working.
  done: [text: string, turnCount: number, traceId: string | undefined];
  idle: [];
  queued: [input: string, queueDepth: number];
  /** Phase 5 — emitted once per turn with the resolved provider/model and routing source.
   *  B3 — the trailing `traceId` is the turn identity; see `done` above. */
  run_start: [
    provider: string,
    model: string,
    source: 'team-coordinator' | 'team-personality' | 'personality' | 'global',
    traceId: string | undefined,
  ];
  /** Emitted when dryRun is active — carries the planned tool calls. */
  dry_run_summary: [plan: DryRunToolPlan[], capped: number];
}

interface QueuedSend {
  input: string;
  opts: BridgeOpts;
}

export class AgentBridge extends EventEmitter<BridgeEventMap> {
  private loop: AgentLoop;
  private controller: AbortController | null = null;
  private textBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: QueuedSend[] = [];
  private readonly queueCap: number;
  private readonly flushIntervalMs: number;
  private readonly turnTimeoutMs: number;
  // Clarify registrations are held on the bridge, not on the loop's
  // ClarifyBridge directly, so they survive `replaceLoop`: each rebuilt loop
  // gets a fresh ClarifyBridge that must be re-bound to the surface.
  private clarifyPresenter:
    | { surfaceType: ClarifySurfaceType; presenter: ClarifyPresenter }
    | undefined;
  private readonly clarifyResolvedListeners = new Set<ClarifyResolvedListener>();
  private activeSink: InMemorySteerSink | null = null;

  constructor(loop: AgentLoop, options: BridgeOptions = {}) {
    super();
    this.loop = loop;
    this.queueCap = options.queueCap ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 16;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60 * 1000;
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  /**
   * The active loop's clarify bridge — reads through to the current loop so
   * `respond()` / `listPending()` follow `replaceLoop`. To register a
   * presenter or resolved-listener, use `setClarifyPresenter` /
   * `onClarifyResolved` instead so the registration survives `replaceLoop`.
   */
  get clarifyBridge(): AgentLoop['clarifyBridge'] {
    return this.loop.clarifyBridge;
  }

  /**
   * Register how this surface presents a pending clarify for its own surface
   * type (G2). The registration is remembered and re-applied to the new
   * loop's ClarifyBridge on `replaceLoop`, so clarify keeps working after a
   * model switch.
   */
  setClarifyPresenter(surfaceType: ClarifySurfaceType, presenter: ClarifyPresenter): void {
    this.clarifyPresenter = { surfaceType, presenter };
    this.loop.clarifyBridge?.registerPresenter(surfaceType, presenter);
  }

  /**
   * Subscribe to clarify resolutions (answer / timeout / cancel) so the
   * surface can tear down its prompt. Re-applied across `replaceLoop`.
   * Returns an unsubscribe function.
   */
  onClarifyResolved(listener: ClarifyResolvedListener): () => void {
    this.clarifyResolvedListeners.add(listener);
    const unsub = this.loop.clarifyBridge?.onResolved(listener);
    return () => {
      this.clarifyResolvedListeners.delete(listener);
      unsub?.();
    };
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Send an input. If a turn is already running, the input is queued (FIFO)
   * and processed when the current turn ends. If the queue is at capacity,
   * an `error: BUSY` event fires and the input is dropped.
   *
   * Returns when the *initial* turn finishes — queued turns continue
   * asynchronously and surface state via `queued` / `idle` events.
   */
  async send(input: string, opts: BridgeOpts): Promise<void> {
    if (this.controller) {
      if (this.queue.length >= this.queueCap) {
        this.emit('error', `Queue full (cap ${this.queueCap}) — drop input`, 'BUSY');
        return;
      }
      this.queue.push({ input, opts });
      this.emit('queued', input, this.queue.length);
      return;
    }
    await this.runTurn(input, opts);
  }

  abortTurn(): void {
    this.controller?.abort();
  }

  /** Drop any pending queued sends. Does not affect the in-flight turn. */
  clearQueue(): number {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }

  steer(text: string): boolean {
    if (!this.activeSink) return false;
    return this.activeSink.push(text);
  }

  /** Returns accumulated spend for the session key (0 if no spend recorded). */
  getSessionCost(sessionKey: string): number {
    return this.loop.getSessionCost(sessionKey);
  }

  /** Resets the session spend counter — call after /new. */
  resetSessionCost(sessionKey: string): void {
    this.loop.resetSessionCost(sessionKey);
  }

  /** Manual `/compact` — force a compaction outside a turn (delegates to the loop). */
  compact(
    sessionKey: string,
    opts?: { instructions?: string; personalityId?: string },
  ): ReturnType<AgentLoop['compact']> {
    return this.loop.compact(sessionKey, opts);
  }

  /** Returns the budget cap for the personality (undefined = no cap). */
  getPersonalityBudgetCap(personalityId?: string): number | undefined {
    return this.loop.getPersonalityBudgetCap(personalityId);
  }

  /**
   * Swap the underlying AgentLoop on the next idle tick.
   * If a turn is in flight, it finishes with the old loop; subsequent turns
   * use the new one. Pending queued sends are cleared (they were addressed to
   * the old loop's context).
   */
  replaceLoop(newLoop: AgentLoop): void {
    this.loop = newLoop;
    this.clearQueue();
    // The new loop has a fresh ClarifyBridge with no presenter — re-bind the
    // surface's clarify registrations so they keep working after the swap.
    const cb = this.loop.clarifyBridge;
    if (!cb) return;
    if (this.clarifyPresenter) {
      cb.registerPresenter(this.clarifyPresenter.surfaceType, this.clarifyPresenter.presenter);
    }
    for (const listener of this.clarifyResolvedListeners) cb.onResolved(listener);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runTurn(input: string, opts: BridgeOpts): Promise<void> {
    this.controller = new AbortController();
    let timedOut = false;

    // Stall guard: if no done/error arrives within turnTimeoutMs, emit an error
    // from outside the suspended for-await loop and unblock the bridge.
    const timeoutHandle = setTimeout(() => {
      if (!this.controller) return; // turn already finished normally
      timedOut = true;
      this.flushText();
      this.emit(
        'error',
        `Agent did not complete within ${Math.round(this.turnTimeoutMs / 60_000)} minutes — turn abandoned.`,
        'TIMEOUT',
      );
      this.controller.abort();
      this.activeSink = null;
      this.controller = null;
      this.emit('idle');
      const next = this.queue.shift();
      if (next) void this.runTurn(next.input, next.opts);
    }, this.turnTimeoutMs);

    const steerSink = new InMemorySteerSink();
    this.activeSink = steerSink;

    try {
      for await (const event of this.loop.run(input, {
        ...opts,
        abortSignal: this.controller.signal,
        steerSink,
      })) {
        switch (event.type) {
          case 'text_delta':
            this.bufferText(event.text);
            break;
          case 'done':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('done', event.text, event.turnCount, event.traceId);
            break;
          case 'thinking_delta':
            this.emit('thinking_delta', event.thinking);
            break;
          case 'tool_start':
            this.emit('tool_start', event.toolCallId, event.toolName, event.args, event.audience);
            break;
          case 'tool_progress':
            this.emit('tool_progress', event.toolName, event.message, event.percent);
            break;
          case 'tool_end':
            this.emit(
              'tool_end',
              event.toolCallId,
              event.toolName,
              event.ok,
              event.durationMs,
              event.result,
              event.structured,
              event.audience,
            );
            break;
          case 'usage':
            this.emit('usage', event.inputTokens, event.outputTokens, event.estimatedCostUsd);
            break;
          case 'error':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('error', event.error, event.code);
            break;
          case 'run_start':
            this.emit('run_start', event.provider, event.model, event.source, event.traceId);
            break;
          case 'dry_run_summary':
            this.emit('dry_run_summary', event.plan, event.capped);
            break;
        }
      }
    } catch (err) {
      clearTimeout(timeoutHandle);
      this.flushText();
      if (timedOut) {
        // Timeout handler already emitted the error and cleaned up bridge state.
      } else if (!this.controller?.signal.aborted) {
        this.emit('error', err instanceof Error ? err.message : String(err), 'UNKNOWN');
      }
      // user-initiated abort: stay silent (deliberate behavior, not an error).
    } finally {
      clearTimeout(timeoutHandle);
      if (!timedOut) {
        // Normal path: timeout handler didn't fire, do normal cleanup.
        this.flushText();
        this.activeSink = null;
        this.controller = null;
        this.emit('idle');
        const next = this.queue.shift();
        if (next) void this.runTurn(next.input, next.opts);
      }
      // If timedOut: timeout handler already nulled controller, emitted idle, and
      // drained the queue. Don't double-process.
    }
  }

  private bufferText(text: string): void {
    this.textBuffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), this.flushIntervalMs);
    }
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.textBuffer) {
      this.emit('text_delta', this.textBuffer);
      this.textBuffer = '';
    }
  }
}
