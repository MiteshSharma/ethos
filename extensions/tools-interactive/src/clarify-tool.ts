// `clarify` — the agent asks the user a structured question mid-turn, waits
// for the answer, and continues. See plan/phases/tool_clarity_plan.md.
//
// The tool blocks inside `execute()` until the ClarifyBridge resolves the
// request (user answer, timeout → default, or cancel). The agent loop is
// paused by the blocked tool — the same way a tool-call approval pauses it.

import {
  type ClarifyBridge,
  ClarifyNoSurfaceError,
  ClarifyTimedOutNoDefaultError,
} from '@ethosagent/core';
import type { ClarifySurfaceType, Tool, ToolResult } from '@ethosagent/types';

const DEFAULT_TIMEOUT_S = 900; // 15 min — uniform across surfaces (plan Q3)
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 86_400; // 24h hard cap (plan)
const MAX_RESULT_CHARS = 2_000;

// Proactive-use rules shipped verbatim in the description (plan — sourced from
// Hermes's `clarify` prompt + Anthropic Computer Use's `wait_for_user`).
const DESCRIPTION = [
  'Ask the user a structured question mid-turn, then wait for their answer before continuing.',
  '',
  'WHEN TO USE',
  "- You need information you can't reasonably infer from context",
  '- There is a small set of valid choices and you want to constrain the answer (use `options`)',
  '- The cost of guessing wrong is high (modifying many files, calling external APIs)',
  '',
  'WHEN NOT TO USE',
  '- Confirmations the user already gave ("you said X, are you sure?")',
  "- Trivia the user clearly knows but didn't include",
  '- As a substitute for reading their previous message carefully',
  '- Avoid in long autonomous loops — clarify forces a pause; use it sparingly',
].join('\n');

interface ClarifyArgs {
  question?: unknown;
  options?: unknown;
  default?: unknown;
  timeout_s?: unknown;
  answerable_by?: unknown;
}

function errorResult(error: string, code: Extract<ToolResult, { ok: false }>['code']): ToolResult {
  return { ok: false, error, code };
}

export function createClarifyTool(bridge: ClarifyBridge): Tool<ClarifyArgs> {
  return {
    name: 'clarify',
    description: DESCRIPTION,
    toolset: 'interactive',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional multiple-choice answers. When omitted, the user answers in free-form text.',
        },
        default: {
          type: 'string',
          description: 'Returned on timeout if the user does not answer in time.',
        },
        timeout_s: {
          type: 'number',
          description: `Seconds to wait before the timeout fires. Default ${DEFAULT_TIMEOUT_S} (15 min).`,
        },
        answerable_by: {
          type: 'string',
          enum: ['anyone', 'originator'],
          description:
            "Group chats: who may answer. 'anyone' (default) or 'originator' to restrict to the user who triggered the turn.",
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) {
        return errorResult('clarify requires a non-empty `question`', 'input_invalid');
      }

      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string' && o.length > 0)
        : undefined;
      const def = typeof args.default === 'string' ? args.default : undefined;
      const timeoutRaw =
        typeof args.timeout_s === 'number' && Number.isFinite(args.timeout_s)
          ? args.timeout_s
          : DEFAULT_TIMEOUT_S;
      const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(timeoutRaw)));
      const answerableBy = args.answerable_by === 'originator' ? 'originator' : 'anyone';

      const startedAt = Date.now();
      try {
        // `surfaceType: ctx.platform` is only the FALLBACK route (today's
        // behaviour for a foreground turn, where it's already correct — the
        // human is on that platform right now). For a background turn
        // (`jobId` set), `ClarifyBridge.request()` resolves the actual route
        // dynamically via its origin resolver + presence tracking (G2/G3/D7),
        // not from this frozen turn-start value.
        const response = await bridge.request({
          question,
          ...(options && options.length > 0 ? { options } : {}),
          ...(def !== undefined ? { default: def } : {}),
          timeoutMs: timeoutS * 1000,
          answerableBy,
          sessionId: ctx.sessionId,
          ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
          surfaceType: ctx.platform as ClarifySurfaceType,
          abortSignal: ctx.abortSignal,
        });
        const tookS = Math.round((Date.now() - startedAt) / 1000);
        return {
          ok: true,
          value: JSON.stringify(
            {
              answer: response.answer,
              requestId: response.requestId,
              took_s: tookS,
              was_default: response.source === 'timeout-default',
              cancelled: response.source === 'cancel',
            },
            null,
            2,
          ),
        };
      } catch (err) {
        if (err instanceof ClarifyNoSurfaceError) {
          return errorResult(
            `CLARIFY_NO_SURFACE: ${err.message}. Ask the question in plain prose instead.`,
            'not_available',
          );
        }
        if (err instanceof ClarifyTimedOutNoDefaultError) {
          return errorResult(`CLARIFY_TIMED_OUT_NO_DEFAULT: ${err.message}`, 'execution_failed');
        }
        return errorResult(err instanceof Error ? err.message : String(err), 'execution_failed');
      }
    },
  };
}
