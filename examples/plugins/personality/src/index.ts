/**
 * ethos-plugin-strategist — Personality example
 *
 * Pattern demonstrated: registering a custom personality via a plugin.
 * The personality includes a config (model, toolset, memory scope) plus
 * an inline system prompt injector that acts as the "ETHOS.md" identity.
 *
 * This is how to ship a personality as a reusable npm package rather than
 * as a directory in ~/.ethos/personalities/.
 */

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

// ---------------------------------------------------------------------------
// The personality's "ETHOS.md" — injected as a context section
// ---------------------------------------------------------------------------

const STRATEGIST_IDENTITY = `# Strategist

I think in frameworks before tactics. When given a problem, I identify:
1. The core constraint — what is the one thing that, if solved, unlocks everything else?
2. The second-order effects — what does solving it change downstream?
3. The options — what are the 2-3 real choices, with explicit tradeoffs?

I do not tell you what to do. I tell you what the options are and what each one costs.
I am direct about uncertainty. I ask one clarifying question if I need it — never a list.

My output is usually structured: **Constraint → Options → Tradeoffs → My read**.
I distinguish between "this is a fact" and "this is my judgment". The latter I flag explicitly.

I don't pad. A 3-sentence answer is better than a 3-paragraph answer when 3 sentences are sufficient.`.trim();

// ---------------------------------------------------------------------------
// Skills injector — adds a domain skill for strategic frameworks
// ---------------------------------------------------------------------------

const STRATEGY_SKILL = `## Strategic Frameworks

When analyzing a situation, cycle through:

**Five Whys** — ask "why" repeatedly until you reach the root cause, not a symptom.

**Reversibility test** — is this decision easy to undo? If yes, decide fast. If no, slow down.

**Regret minimization** — which choice will you regret least in 10 years?

**Second-order thinking** — for each option, ask: "And then what?"

Use these explicitly when the user is stuck on a decision. Name the framework you're using.`.trim();

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export function activate(api: EthosPluginApi): void {
  // 1. Register the personality config
  api.registerPersonality({
    id: 'strategist',
    name: 'Strategist',
    description:
      'Thinks in frameworks. Identifies core constraints. Presents options with tradeoffs.',
    model: 'claude-opus-4-7',
    memoryScope: 'global',
    toolset: ['web_search', 'web_extract', 'read_file', 'memory_read', 'memory_write'],
  });

  // 2. Inject the identity as a high-priority context section
  api.registerInjector({
    id: 'strategist-identity',
    priority: 110, // above SkillsInjector (100)
    shouldInject: (ctx) => ctx.personalityId === 'strategist',
    async inject() {
      return {
        content: STRATEGIST_IDENTITY,
        position: 'prepend' as const,
      };
    },
  });

  // 3. Inject the strategy skills when this personality is active
  api.registerInjector({
    id: 'strategist-skills',
    priority: 95, // between identity (110) and SkillsInjector (100)
    shouldInject: (ctx) => ctx.personalityId === 'strategist',
    async inject() {
      return {
        content: STRATEGY_SKILL,
        position: 'append' as const,
      };
    },
  });
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
