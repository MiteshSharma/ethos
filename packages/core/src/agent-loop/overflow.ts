// Phase 3 — context-overflow detection. When a provider rejects a completion
// because the request exceeds the model's context window, the turn should
// compact-and-retry instead of surfacing a raw error. Providers report this
// differently (Anthropic: 400 `invalid_request_error` "prompt is too long";
// OpenAI-compat: `context_length_exceeded` / "maximum context length"), so we
// match on both the structured error code/type and the message text.

import type {
  ContextEngine,
  ContextEngineLLMHandle,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { estimateMessagesTokens, estimateTokens } from '../context-engines/token-estimator';
import type { LoopDeps } from './turn-context';

// The bare phrases `too many tokens` / `too long for` are context-anchored: a
// non-overflow error like `value too long for column X` (SQLite/Postgres/
// validation) must NOT match. A false negative just surfaces the original error
// (status quo); a false positive would silently drop history on a NON-overflow
// failure, so we require a context/prompt/model reference near those phrases.
const OVERFLOW_MESSAGE_RE =
  /context[_ ]?length|context window|maximum context|prompt is too long|(?:context|prompt|input|request|conversation|window|the model)[^\n]{0,40}?too many tokens|reduce the (?:length|number)|input is too long|exceeds? the maximum (?:context|number of tokens)|too long for (?:the |this |your )?(?:model|context|conversation|prompt|input|window|request)/i;

const OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'string_above_max_length',
]);

/**
 * Best-effort classification of a provider error as a context-window overflow.
 * Deliberately conservative on the structured signals (a fixed code set) and
 * broad on the message text — a false negative just surfaces the original
 * error (status quo), while a false positive would waste one compaction+retry.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const type = typeof e.type === 'string' ? e.type : undefined;
  if ((code && OVERFLOW_CODES.has(code)) || (type && OVERFLOW_CODES.has(type))) return true;
  // Some SDKs nest the structured error one level down.
  const nested = e.error as { code?: unknown; type?: unknown } | undefined;
  if (nested && typeof nested === 'object') {
    const ncode = typeof nested.code === 'string' ? nested.code : undefined;
    const ntype = typeof nested.type === 'string' ? nested.type : undefined;
    if ((ncode && OVERFLOW_CODES.has(ncode)) || (ntype && OVERFLOW_CODES.has(ntype))) return true;
  }
  const msg = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : '';
  return msg.length > 0 && OVERFLOW_MESSAGE_RE.test(msg);
}

/**
 * Deterministically shrink an over-long in-memory history for the compact-and-
 * retry path. An overflow means the pressure estimate UNDERSHOT the real token
 * count, so the target is derived from the CURRENT estimate (halved), not a
 * window fraction — guaranteeing the engine actually drops when there is more
 * than one message. Falls back to keeping the last message so the retry never
 * ships an empty history. Returns the original messages on engine failure, with
 * `summaryError` set — the caller distinguishes "the engine threw" from "the
 * engine ran but could not shrink", which `compaction.abortOnSummaryFailure`
 * keys on.
 */
export async function emergencyCompact(
  engine: ContextEngine,
  messages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMetadata: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
  },
  extra?: { llm?: ContextEngineLLMHandle; countTokens?: (m: Message[]) => Promise<number> },
): Promise<{ messages: Message[]; summaryError?: string }> {
  const currentEstimate = estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
  const targetTokens = Math.max(1, Math.floor(currentEstimate / 2));
  try {
    const result = await engine.compact({
      messages,
      currentSystem: systemPrompt,
      targetTokens,
      personality,
      sessionMetadata,
      ...(extra?.llm ? { llm: extra.llm } : {}),
      ...(extra?.countTokens ? { countTokens: extra.countTokens } : {}),
    });
    if (result.messages.length === 0 && messages.length > 0) {
      const last = messages[messages.length - 1];
      return { messages: last ? [last] : messages };
    }
    return { messages: result.messages };
  } catch (err) {
    return { messages, summaryError: err instanceof Error ? err.message : String(err) };
  }
}

/** Outcome of one compact-and-retry attempt. */
export interface OverflowRetryResult {
  /** History was shrunk in place — the caller re-runs the current iteration. */
  retried: boolean;
  /** Set when the context engine THREW, as opposed to running without shrinking. */
  summaryError?: string;
}

/**
 * Overflow→compact-and-retry seam for the loop. Resolves the personality's
 * engine (or the per-model-class default), runs {@link emergencyCompact}, and —
 * when it shrinks — replaces `llmMessages` IN PLACE and reports `retried: true`
 * so the caller re-runs the current iteration. Reports `retried: false` when
 * nothing could be trimmed (the caller then surfaces the overflow error), with
 * `summaryError` set when the engine raised rather than merely failing to
 * shrink.
 */
export async function applyOverflowRetry(
  deps: Pick<LoopDeps, 'llm' | 'contextEngines' | 'llmHandle' | 'compaction'>,
  llmMessages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMeta: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
  },
): Promise<OverflowRetryResult> {
  const engineName = personality.context_engine ?? deps.compaction?.defaultEngine ?? 'drop_oldest';
  const engine = deps.contextEngines.get(engineName) ?? deps.contextEngines.get('drop_oldest');
  if (!engine) return { retried: false };
  const { messages: trimmed, summaryError } = await emergencyCompact(
    engine,
    llmMessages,
    systemPrompt,
    personality,
    sessionMeta,
    {
      ...(deps.llmHandle ? { llm: deps.llmHandle } : {}),
      countTokens: deps.llm.countTokens.bind(deps.llm),
    },
  );
  if (trimmed.length >= llmMessages.length) {
    return { retried: false, ...(summaryError !== undefined ? { summaryError } : {}) };
  }
  llmMessages.length = 0;
  llmMessages.push(...trimmed);
  return { retried: true };
}

/**
 * Which error a non-recoverable overflow surfaces. `abortOnSummaryFailure`
 * promotes a THROWN emergency summary to its own code so the real cause is not
 * masked by the provider's generic overflow rejection; without it (the
 * default), and whenever the engine merely failed to shrink, the provider's
 * error is reported unchanged.
 */
export function overflowErrorEvent(
  retry: OverflowRetryResult,
  providerError: string,
  compaction: { abortOnSummaryFailure?: boolean } | undefined,
): { error: string; code: string } {
  if (compaction?.abortOnSummaryFailure === true && retry.summaryError !== undefined) {
    return {
      error: `compaction summary failed: ${retry.summaryError}`,
      code: 'compaction_summary_failed',
    };
  }
  return { error: providerError, code: 'context_overflow' };
}
