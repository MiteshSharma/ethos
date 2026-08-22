import type { A2aTaskRunner } from '@ethosagent/a2a';
import type { AgentLoop } from '@ethosagent/core';
import { resolveA2aSkillTools } from '@ethosagent/personalities';
import type { PersonalityConfig, Storage } from '@ethosagent/types';

// The A2A task runner (plan T0.2). Extracted from `runServe` so the
// fail-closed tool-narrowing logic is unit-testable without booting a real
// server — mirrors `serve-helpers.ts`.
//
// Today an authorized peer names a skill in `params.skill`, it is checked at
// admission against the trusted-peer card (`exposeToAgents`), and then
// discarded: the runner used to hand the model the personality's ENTIRE
// toolset regardless of which skill was invoked. This resolves the named
// skill's `required_tools` (walking the SAME `skillsDirs` the card builder
// walks, parsing SKILL.md with the SAME reader — D8) and sets
// `RunOptions.toolsetNarrow`, so an inbound turn's tools are exactly
// `personality.toolset ∩ required_tools` (the intersection itself happens
// downstream in `setupTurn`, already tested at
// `packages/core/src/agent-loop/stages/__tests__/turn-setup-narrow.test.ts`).
//
// Fails closed (D2): a missing SKILL.md, or one with no `required_tools` key
// at all, refuses the turn — yielding a typed, auditable `error` AgentEvent
// rather than falling back to the personality's full toolset. Explicit
// `required_tools: []` is a real, legitimate empty grant, not a refusal.

/** `AgentEvent.code` for a T0.2 fail-closed refusal. */
export const A2A_SKILL_TOOLS_UNDECLARED = 'A2A_SKILL_TOOLS_UNDECLARED';

/** The minimal personality-lookup surface the runner needs. */
export interface A2aRunnerPersonalitySource {
  get(id: string): PersonalityConfig | undefined;
}

export interface CreateA2aRunnerDeps {
  loop: AgentLoop;
  personalities: A2aRunnerPersonalitySource;
  storage: Storage;
  /** Reserve one outbound call against a trace's fan-out budget (P8). */
  reserveOutbound: (traceId: string) => boolean;
}

export function createA2aRunner(deps: CreateA2aRunnerDeps): A2aTaskRunner {
  return {
    run: async function* (personalityId, text, opts) {
      const delegation = opts?.delegation;
      const skillName = opts?.skill;
      let toolsetNarrow: string[] | undefined;

      if (skillName !== undefined) {
        const config = deps.personalities.get(personalityId);
        const resolution = config
          ? await resolveA2aSkillTools(deps.storage, config, skillName)
          : { found: false as const };
        if (resolution.requiredTools === undefined) {
          yield {
            type: 'error',
            error: resolution.found
              ? `A2A skill "${skillName}" has no "required_tools" declared in its SKILL.md — refusing to run with an unscoped toolset.`
              : `A2A skill "${skillName}" has no matching SKILL.md in this personality's skills directory — refusing to run.`,
            code: A2A_SKILL_TOOLS_UNDECLARED,
          };
          return;
        }
        toolsetNarrow = resolution.requiredTools;
      }

      yield* deps.loop.run(text, {
        personalityId,
        ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
        ...(toolsetNarrow ? { toolsetNarrow } : {}),
        ...(delegation
          ? {
              a2aDelegation: {
                traceId: delegation.traceId,
                depth: delegation.depth,
                reserveOutbound: () => deps.reserveOutbound(delegation.traceId),
              },
            }
          : {}),
      });
    },
  };
}
