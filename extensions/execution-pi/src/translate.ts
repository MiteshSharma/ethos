import type { AgentEvent } from '@ethosagent/types';
import { type PiEvent, type PiUsage, toolResultText } from './protocol';

/**
 * Pi RPC event -> `AgentEvent` translation.
 *
 * `AgentEvent` is frozen with a CI drift gate, so this maps ONTO the existing
 * variants and never invents one. The mapping, and why each line is what it is:
 *
 * | Pi event                                    | AgentEvent            |
 * |---------------------------------------------|-----------------------|
 * | `message_update` + `text_delta`              | `text_delta`          |
 * | `message_update` + `thinking_delta`          | `thinking_delta`      |
 * | `message_update.usage` (cumulative)          | `usage` (a DELTA, at agent_end) |
 * | `tool_execution_start`                       | `tool_start`          |
 * | `tool_execution_end`                         | `tool_end`            |
 * | `agent_settled`                              | `done` (via `finish`) |
 * | `response` with `success: false`             | `error`               |
 *
 * Deliberately unmapped: `turn_start`/`turn_end` (counted, not emitted),
 * `message_start`/`message_end` (the deltas already carry the text),
 * `queue_update` (steering bookkeeping), `tool_execution_update` (Pi's partial
 * result is cumulative, and `tool_progress` would be `audience: 'internal'`
 * noise for a background job nobody is watching live), `extension_error` (the
 * host logs it — it is our gate misbehaving, not the child's output), and file
 * diffs (no AgentEvent slot at all — those travel via `ctx.emitArtifact`).
 *
 * Pure and clock-injected so the whole mapping is unit-testable without Docker,
 * Pi, or a network.
 */
export class PiEventTranslator {
  private readonly toolStarts = new Map<string, number>();
  private text = '';
  private turns = 0;
  /** Usage of messages that have already rolled over (see `absorbUsage`). */
  private carried: Required<Omit<PiUsage, 'cost'>> & { cost: number } = zero();
  /** Latest cumulative snapshot for the in-flight message. */
  private current: Required<Omit<PiUsage, 'cost'>> & { cost: number } = zero();
  /** What has already been emitted, so every `usage` event carries a delta. */
  private emitted: Required<Omit<PiUsage, 'cost'>> & { cost: number } = zero();

  constructor(private readonly now: () => number = Date.now) {}

  /** Text the child produced so far — the body of the terminal `done`. */
  get outputText(): string {
    return this.text;
  }

  translate(evt: PiEvent): AgentEvent[] {
    switch (evt.type) {
      case 'turn_start':
        this.turns += 1;
        return [];
      case 'message_update': {
        const update = evt as Extract<PiEvent, { type: 'message_update' }>;
        if (update.usage) this.absorbUsage(update.usage);
        const delta = update.assistantMessageEvent;
        if (delta?.type === 'text_delta' && delta.delta) {
          this.text += delta.delta;
          return [{ type: 'text_delta', text: delta.delta }];
        }
        if (delta?.type === 'thinking_delta' && delta.delta) {
          return [{ type: 'thinking_delta', thinking: delta.delta }];
        }
        return [];
      }
      case 'tool_execution_start': {
        const start = evt as Extract<PiEvent, { type: 'tool_execution_start' }>;
        this.toolStarts.set(start.toolCallId, this.now());
        return [
          {
            type: 'tool_start',
            toolCallId: start.toolCallId,
            toolName: start.toolName,
            args: start.args,
          },
        ];
      }
      case 'tool_execution_end': {
        const end = evt as Extract<PiEvent, { type: 'tool_execution_end' }>;
        const startedAt = this.toolStarts.get(end.toolCallId);
        this.toolStarts.delete(end.toolCallId);
        const body = toolResultText(end.result);
        const ok = end.isError !== true;
        return [
          {
            type: 'tool_end',
            toolCallId: end.toolCallId,
            toolName: end.toolName,
            ok,
            durationMs: startedAt === undefined ? 0 : this.now() - startedAt,
            ...(body ? { result: body } : {}),
            ...(ok ? {} : { error: body || 'tool failed' }),
          },
        ];
      }
      case 'agent_end':
        return this.flushUsage();
      case 'response': {
        const res = evt as Extract<PiEvent, { type: 'response' }>;
        if (res.success === false) {
          return [
            {
              type: 'error',
              error: `pi command '${res.command ?? 'unknown'}' failed: ${res.error ?? 'no reason given'}`,
              code: 'pi_command_failed',
            },
          ];
        }
        return [];
      }
      default:
        return [];
    }
  }

  /** Terminal events for a run that reached `agent_settled` (or was stopped). */
  finish(): AgentEvent[] {
    return [
      ...this.flushUsage(),
      { type: 'done', text: this.text, turnCount: Math.max(this.turns, 1) },
    ];
  }

  /**
   * Fold one cumulative snapshot in. Pi reports usage cumulatively, but the
   * counters restart when a new assistant message begins, so a snapshot that
   * moved BACKWARDS means the previous message closed: bank it and start over.
   * Getting this wrong double-counts spend and trips `max_cost_usd` on a run
   * that never cost that much.
   */
  private absorbUsage(usage: PiUsage): void {
    const next = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    };
    const restarted =
      next.input < this.current.input ||
      next.output < this.current.output ||
      next.cost < this.current.cost;
    if (restarted) {
      this.carried = add(this.carried, this.current);
      this.current = next;
      return;
    }
    this.current = next;
  }

  /** Emit the not-yet-reported portion of accumulated usage, if any. */
  private flushUsage(): AgentEvent[] {
    const total = add(this.carried, this.current);
    const delta = {
      input: total.input - this.emitted.input,
      output: total.output - this.emitted.output,
      cacheRead: total.cacheRead - this.emitted.cacheRead,
      cacheWrite: total.cacheWrite - this.emitted.cacheWrite,
      cost: total.cost - this.emitted.cost,
    };
    if (delta.input <= 0 && delta.output <= 0 && delta.cost <= 0) return [];
    this.emitted = total;
    return [
      {
        type: 'usage',
        inputTokens: delta.input,
        outputTokens: delta.output,
        estimatedCostUsd: delta.cost,
        // Present only when the provider actually reported cache activity —
        // absent tells a consumer "no caching", a 0 would say "cached nothing".
        ...(delta.cacheRead > 0 ? { cacheReadTokens: delta.cacheRead } : {}),
        ...(delta.cacheWrite > 0 ? { cacheCreationTokens: delta.cacheWrite } : {}),
      },
    ];
  }
}

type Counters = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function zero(): Counters {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function add(a: Counters, b: Counters): Counters {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}
