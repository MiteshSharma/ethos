// One cron firing's agent turn: pick the session it runs in, then run it.
// Pure of the serve command's wiring (loop and session store are injected) so
// the routing rule and the failure path are unit-testable.

import { type AgentEvent, EthosError } from '@ethosagent/types';

/** The slice of `AgentLoop` a cron firing needs. */
interface CronTurnLoop {
  run(
    text: string,
    opts: { sessionKey: string; personalityId: string; toolsetOverride?: string[] },
  ): AsyncIterable<AgentEvent>;
}

/** The slice of `SessionStore` a cron firing needs. */
interface CronTurnSessions {
  getSessionByKey(key: string): Promise<{ personalityId?: string } | null>;
}

export interface CronTurnInput {
  loop: CronTurnLoop;
  sessions: CronTurnSessions;
  jobId: string;
  prompt: string;
  personalityId: string;
  toolsetOverride?: string[];
  /** The originating web chat's session key, when the job was created from one. */
  webOrigin?: string | null;
}

export interface CronTurnResult {
  sessionKey: string;
  output: string;
  /** True when the turn ran in the originating web chat's session. */
  reusedWebOrigin: boolean;
}

/**
 * Run a cron job's turn.
 *
 * Session routing: reuse the originating web chat's session key so the firing
 * lands in that chat's history and the client can reload to show it. That reuse
 * only holds while the job's personality IS the one the web session is bound
 * to — a session's personality is fixed at creation, so a mismatched turn is
 * refused with `personality_locked` and the firing would record nothing. On a
 * mismatch the job runs in its own `cron:<id>:<iso>` session instead. A web
 * session that does not exist yet, or that predates the binding rule, still
 * reuses the key: this turn binds it.
 *
 * Failure: a refused or errored turn emits `error` and no text. Throwing makes
 * the scheduler record `lastError` for the job, which is the same contract a
 * failed script job uses — silently persisting an empty output is not an option.
 */
export async function runCronTurn(input: CronTurnInput): Promise<CronTurnResult> {
  const { loop, sessions, jobId, prompt, personalityId, toolsetOverride } = input;
  const webOrigin = input.webOrigin ?? null;

  const boundPersonalityId = webOrigin
    ? ((await sessions.getSessionByKey(webOrigin))?.personalityId ?? null)
    : null;
  const reusedWebOrigin =
    webOrigin !== null && (boundPersonalityId === null || boundPersonalityId === personalityId);
  const sessionKey =
    reusedWebOrigin && webOrigin !== null ? webOrigin : `cron:${jobId}:${new Date().toISOString()}`;

  let output = '';
  let failure: string | undefined;
  for await (const event of loop.run(prompt, {
    sessionKey,
    personalityId,
    ...(toolsetOverride ? { toolsetOverride } : {}),
  })) {
    if (event.type === 'text_delta') output += event.text;
    else if (event.type === 'error') failure = `[${event.code}] ${event.error}`;
  }
  if (failure) {
    throw new EthosError({
      code: 'CRON_RUN_FAILED',
      cause: `Cron job "${jobId}" turn failed: ${failure}`,
      action: `Run 'ethos cron list' to inspect the job, then check its personality and prompt.`,
    });
  }

  return { sessionKey, output, reusedWebOrigin };
}
