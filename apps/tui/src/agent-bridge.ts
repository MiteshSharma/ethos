import { EventEmitter } from 'node:events';
import type { AgentLoop, RunOptions } from '@ethosagent/core';

export type BridgeOpts = Omit<RunOptions, 'abortSignal'>;

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
}

export class AgentBridge extends EventEmitter<BridgeEventMap> {
  private loop: AgentLoop;
  private controller: AbortController | null = null;
  private textBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(loop: AgentLoop) {
    super();
    this.loop = loop;
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  async send(input: string, opts: BridgeOpts): Promise<void> {
    if (this.controller) return;
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
    }
  }

  abortTurn(): void {
    this.controller?.abort();
  }

  private bufferText(text: string): void {
    this.textBuffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), 16);
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
