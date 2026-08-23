import type { AgentEvent } from '@ethosagent/types';
import type { AcpContentBlock, AcpPromptResult, AcpSessionUpdate } from './acp-protocol';

/**
 * `session/update` -> `AgentEvent` translation — the real-ACP analogue of
 * `execution-pi/src/translate.ts`'s `PiEventTranslator`, mapping a DIFFERENT
 * wire vocabulary onto the SAME frozen 17-variant union.
 *
 * | ACP `session/update`                          | AgentEvent       |
 * |------------------------------------------------|------------------|
 * | `agent_message_chunk` (text content)            | `text_delta`     |
 * | `agent_thought_chunk` (text content)             | `thinking_delta` |
 * | `tool_call`                                       | `tool_start`     |
 * | `tool_call_update` with `status: completed/failed`| `tool_end`       |
 * | `session/prompt`'s response (`stopReason`/`usage`)| `done` + `usage` (see `finish`) |
 *
 * Deliberately unmapped: `user_message_chunk` (our own prompt echoed back —
 * Pi's translator skips the equivalent for the same reason), `tool_call_update`
 * with `status: pending/in_progress` (no `tool_progress` audience decision has
 * been made for this runner yet — see the plan's Open Question 3 caveat: file
 * diffs and richer progress both wait on a real agent's payload shape), and
 * every other open `sessionUpdate` string (`plan`, `available_commands_update`,
 * etc. — forward-compatible no-ops, same posture `AgentEvent` itself asks
 * every consumer to take on an unknown variant).
 *
 * `estimatedCostUsd` is honestly `0`, never fabricated: ACP's `Usage` carries
 * token counts only (no cost field) — ARCHITECTURE.md's frozen `AgentEvent`
 * union makes the field required, so `0` is reported rather than inventing a
 * number this package has no pricing table to back.
 *
 * Pure, so the whole mapping is unit-testable without Docker or a real agent.
 */
export class AcpEventTranslator {
  private readonly toolStarts = new Map<string, number>();
  private readonly toolLabels = new Map<string, string>();
  private text = '';

  constructor(private readonly now: () => number = Date.now) {}

  /** Text the agent produced so far — the body of the terminal `done`. */
  get outputText(): string {
    return this.text;
  }

  translate(update: AcpSessionUpdate): AgentEvent[] {
    // Cast within each case rather than rely on switch narrowing — same
    // pattern `execution-pi/src/translate.ts` uses for its own open-string
    // catch-all union member, for the same reason: a `{ sessionUpdate:
    // string; [key: string]: unknown }` fallback variant is structurally
    // compatible with every literal case, so a plain `switch` cannot narrow
    // `update` on its own.
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const msg = update as Extract<AcpSessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
        const text = textOf(msg.content);
        if (!text) return [];
        this.text += text;
        return [{ type: 'text_delta', text }];
      }
      case 'agent_thought_chunk': {
        const msg = update as Extract<AcpSessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
        const text = textOf(msg.content);
        return text ? [{ type: 'thinking_delta', thinking: text }] : [];
      }
      case 'tool_call': {
        const call = update as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>;
        const toolCallId = String(call.toolCallId);
        const label = call.name ?? call.title ?? toolCallId;
        this.toolLabels.set(toolCallId, label);
        this.toolStarts.set(toolCallId, this.now());
        return [
          {
            type: 'tool_start',
            toolCallId,
            toolName: label,
            args: call.rawInput,
          },
        ];
      }
      case 'tool_call_update': {
        const upd = update as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>;
        if (upd.status !== 'completed' && upd.status !== 'failed') return [];
        const toolCallId = String(upd.toolCallId);
        const startedAt = this.toolStarts.get(toolCallId);
        this.toolStarts.delete(toolCallId);
        const label = upd.name ?? upd.title ?? this.toolLabels.get(toolCallId) ?? toolCallId;
        this.toolLabels.delete(toolCallId);
        const ok = upd.status !== 'failed';
        // Deliberately no `result`/error body pulled from `update.content`:
        // the real schema's tool-call content can carry a `diff` variant
        // (file-change data), which must route through `job_events`/
        // `ctx.emitArtifact`, never `AgentEvent` — see the NOTE on
        // `AcpToolCallUpdate` in `acp-protocol.ts`. ok/failed status is the
        // one signal safe to report without that routing decision.
        return [
          {
            type: 'tool_end',
            toolCallId,
            toolName: label,
            ok,
            durationMs: startedAt === undefined ? 0 : this.now() - startedAt,
            ...(ok ? {} : { error: 'tool failed' }),
          },
        ];
      }
      default:
        return [];
    }
  }

  /** Terminal events once `session/prompt` resolves. */
  finish(result: AcpPromptResult): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (result.usage && (result.usage.inputTokens || result.usage.outputTokens)) {
      events.push({
        type: 'usage',
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        estimatedCostUsd: 0,
      });
    }
    events.push({ type: 'done', text: this.text, turnCount: 1 });
    return events;
  }
}

/** Flatten a `session/update` content payload down to its plain text, when it has any. */
function textOf(content: AcpContentBlock | undefined): string {
  if (content?.type !== 'text') return '';
  // `AcpContentBlock`'s open catch-all arm (`{ type: string; [k]: unknown }`)
  // overlaps `type: 'text'` structurally, so the narrowing above still leaves
  // `.text` typed as `unknown` — same open-union caveat as the `sessionUpdate`
  // discriminant above. Guard explicitly rather than trust a cast.
  const text: unknown = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}
