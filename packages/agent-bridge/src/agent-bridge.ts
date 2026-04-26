// AgentBridge — adapt AgentLoop's async-generator stream into an EventEmitter
// surface every UI surface (TUI, web, VS Code) can subscribe to identically.
//
// Per Phase 26 eng-review:
//   • finding 1.3 — concurrent sends are queued (FIFO, cap 10), not silently
//     dropped. Emits `queued` when held; `error: BUSY` when cap hit.

import { EventEmitter } from 'node:events';
import type { AgentLoop, RunOptions } from '@ethosagent/core';

export type BridgeOpts = Omit<RunOptions, 'abortSignal'>;

export interface BridgeOptions {
  /** Max concurrent-send queue depth before new sends are rejected with BUSY. */
  queueCap?: number;
  /** Text buffer flush cadence in ms (default 16, ~60fps). */
  flushIntervalMs?: number;
}

interface BridgeEventMap {
  text_delta: [text: string];
  thinking_delta: [thinking: string];
  tool_start: [toolCallId: string, toolName: string, args: unknown];
  tool_progress: [toolName: string, message: string, percent: number | undefined];
  tool_end: [toolCallId: string, toolName: string, ok: boolean, durationMs: number];
  usage: [inputTokens: number, outputTokens: number, estimatedCostUsd: number];
  error: [error: string, code: string];
  done: [text: string, turnCount: number];
  idle: [];
  queued: [input: string, queueDepth: number];
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

  constructor(loop: AgentLoop, options: BridgeOptions = {}) {
    super();
    this.loop = loop;
    this.queueCap = options.queueCap ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 16;
  }

  get isRunning(): boolean {
    return this.controller !== null;
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runTurn(input: string, opts: BridgeOpts): Promise<void> {
    this.controller = new AbortController();
    try {
      for await (const event of this.loop.run(input, {
        ...opts,
        abortSignal: this.controller.signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            this.bufferText(event.text);
            break;
          case 'done':
            this.flushText();
            this.emit('done', event.text, event.turnCount);
            break;
          case 'thinking_delta':
            this.emit('thinking_delta', event.thinking);
            break;
          case 'tool_start':
            this.emit('tool_start', event.toolCallId, event.toolName, event.args);
            break;
          case 'tool_progress':
            this.emit('tool_progress', event.toolName, event.message, event.percent);
            break;
          case 'tool_end':
            this.emit('tool_end', event.toolCallId, event.toolName, event.ok, event.durationMs);
            break;
          case 'usage':
            this.emit('usage', event.inputTokens, event.outputTokens, event.estimatedCostUsd);
            break;
          case 'error':
            this.flushText();
            this.emit('error', event.error, event.code);
            break;
        }
      }
    } catch (err) {
      this.flushText();
      if (!this.controller?.signal.aborted) {
        this.emit('error', err instanceof Error ? err.message : String(err), 'UNKNOWN');
      }
    } finally {
      this.flushText();
      this.controller = null;
      this.emit('idle');
      // Drain the queue head — async, doesn't block the original send promise.
      const next = this.queue.shift();
      if (next) {
        void this.runTurn(next.input, next.opts);
      }
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
