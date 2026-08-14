// The realtime session's tool host: ONE object that both advertises and
// services, so the two can never drift.
//
// A realtime session's tool list is spoken capability. When the provider is
// told it has a tool, the model will offer that capability out loud —
// "sure, let me look that up" — and a person on a phone will wait for it. A
// list that names something the server cannot service is therefore not a
// dropped request, it is a lie delivered in a friendly voice with no way for
// the listener to detect it. So the advertised list and the handled set are not
// two lists that agree; they are one list, derived once from the tool registry
// that is actually wired, and the mint and the control lane both build it from
// here (voice V1b, "advertised == handled").
//
// EVERYTHING dispatched here goes through the same `before_tool_call` hook the
// agent loop fires, carrying the same `voiceOrigin`. That is what keeps the
// approval surface — including A8's spoken-confirmation gate and its rule that
// a far-end caller's voice can never satisfy an owner confirmation — in force
// on a tool the realtime model called directly rather than through
// `agent_consult`.

import type {
  HookRegistry,
  RealtimeToolDefinition,
  ToolContext,
  ToolProgressEvent,
  ToolRegistry,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { sanitizeForSpeech } from '@ethosagent/voice-text';
import { deriveRealtimeToolset, REALTIME_SAFE_TOOLS } from './agent-consult';

/** One tool call as the provider issued it. */
export interface RealtimeToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** Per-call context the host needs to build a `ToolContext`. */
export interface RealtimeDispatchContext {
  /** The talk session's own SessionStore row id. */
  sessionId: string;
  /** The talk session's lane key — also the consulted turn's session key. */
  sessionKey: string;
  personalityId?: string;
  platform: string;
  workingDir: string;
  abortSignal: AbortSignal;
  /** Stamped on the approval hook. See {@link RealtimeToolHostOptions.voiceOrigin}. */
  voiceOrigin: VoiceTurnOrigin;
}

export interface RealtimeToolResult {
  ok: boolean;
  /** Speakable text, already through `sanitizeForSpeech`. */
  output: string;
  /**
   * Machine code for telemetry and tests. Deliberately NOT part of `output`:
   * `sanitizeForSpeech` eats the underscores out of a snake_case code (it reads
   * them as markdown emphasis), and a code is not something to read aloud
   * anyway. It does not travel on the wire — the model gets prose.
   */
  code?: string;
}

export interface RealtimeToolHostOptions {
  registry: ToolRegistry;
  /** Fires `before_tool_call`. Absent → nothing gates; wire it in production. */
  hooks?: HookRegistry;
  /** The speaking personality's toolset; gates the direct-call allowlist. */
  personalityToolset?: readonly string[];
  /** Override the direct-call allowlist. Defaults to {@link REALTIME_SAFE_TOOLS}. */
  safeTools?: ReadonlySet<string>;
  /**
   * Per-call budget for a directly-dispatched tool's result. Small on purpose:
   * this text is spoken. `agent_consult` caps itself far lower still.
   */
  resultBudgetChars?: number;
}

export interface RealtimeToolHost {
  /** What the session is minted advertising. */
  readonly definitions: RealtimeToolDefinition[];
  /** What this host will service. Equal to `definitions.map(d => d.name)`, by construction. */
  readonly handled: string[];
  dispatch(call: RealtimeToolCall, ctx: RealtimeDispatchContext): Promise<RealtimeToolResult>;
}

/** Result code for a name the session was never given. Stable; tests match it. */
export const REALTIME_UNKNOWN_TOOL = 'unknown_tool';

const DEFAULT_RESULT_BUDGET_CHARS = 4_000;

export function createRealtimeToolHost(opts: RealtimeToolHostOptions): RealtimeToolHost {
  const definitions = deriveRealtimeToolset({
    registry: opts.registry,
    ...(opts.personalityToolset ? { personalityToolset: opts.personalityToolset } : {}),
    ...(opts.safeTools ? { safeTools: opts.safeTools } : {}),
  });
  const handled = definitions.map((definition) => definition.name);
  const handledSet = new Set(handled);
  const budget = opts.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS;

  return {
    definitions,
    handled,

    async dispatch(call, ctx): Promise<RealtimeToolResult> {
      if (!handledSet.has(call.name)) {
        // Reached only if a provider invents a name or a session outlives a
        // configuration change. Answering with a refusal rather than silence
        // keeps the model's turn accounting intact — an unanswered tool call
        // leaves a realtime session waiting forever.
        return {
          ok: false,
          code: REALTIME_UNKNOWN_TOOL,
          output: speakable(`This call has no way to run "${call.name}".`),
        };
      }

      let args: unknown = call.args;
      if (opts.hooks) {
        const gate = await opts.hooks.fireModifying('before_tool_call', {
          sessionId: ctx.sessionId,
          toolCallId: call.callId,
          toolName: call.name,
          args,
          voiceOrigin: ctx.voiceOrigin,
        });
        if (gate.error) return { ok: false, code: 'refused', output: speakable(gate.error) };
        if (gate.args !== undefined) args = gate.args;
      }

      const toolCtx: ToolContext = {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir,
        ...(ctx.personalityId ? { personalityId: ctx.personalityId } : {}),
        currentTurn: 1,
        messageCount: 0,
        abortSignal: ctx.abortSignal,
        // Realtime tool progress is internal by contract (Phase 30.2): the
        // spoken filler is this tier's user-facing progress, and a second
        // stream of it would talk over the first.
        emit: (_event: ToolProgressEvent) => {},
        resultBudgetChars: budget,
      };

      const [outcome] = await opts.registry.executeParallel(
        [{ toolCallId: call.callId, name: call.name, args }],
        toolCtx,
        handled,
      );
      if (!outcome) {
        return {
          ok: false,
          code: 'no_result',
          output: speakable(`"${call.name}" did not return anything.`),
        };
      }
      return outcome.result.ok
        ? { ok: true, output: speakable(outcome.result.value) }
        : { ok: false, code: outcome.result.code, output: speakable(outcome.result.error) };
    },
  };
}

/**
 * Everything leaving this host is about to be read aloud by a provider that
 * will happily pronounce backticks, so it goes through the ONE speakable-text
 * implementation (`@ethosagent/voice-text`) on the way out — the realtime
 * tier's coverage for the "TTS speaks the wrong text" failure class. Applied
 * here rather than at the socket so a tier that grows a second surface cannot
 * acquire an unsanitized path.
 */
function speakable(text: string): string {
  const clean = sanitizeForSpeech(text).trim();
  // Never answer a tool call with nothing: a realtime model handed an empty
  // string tends to fill the silence with an invention.
  return clean || 'The assistant had nothing to say about that.';
}
