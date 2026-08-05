// Lane 5(i) — tier-mismatch startup diagnostic.
//
// `resolveModelWithTier` (packages/core/src/agent-loop/turn-context.ts) only
// honors a personality's `model` tier map when the personality's declared
// `provider` matches the active LLM's name — the guard prevents e.g.
// Anthropic-specific model IDs from being injected into an Ollama/OpenRouter
// provider, and it STAYS. Its side effect is that a personality declaring
// tiers without a matching `provider` gets them silently dropped: every turn
// falls through to the global model. This helper makes the mismatch visible
// at loop construction. Warning, not refusal (plan risk note: surfacing
// latent misconfiguration is the point).

import type { PersonalityConfig } from '@ethosagent/types';

/**
 * Returns a warning message when `personality` declares a model tier map that
 * the active LLM will silently ignore, or `undefined` when there is nothing
 * to say (no `model` block, a plain string model, or a matching provider).
 * Pure — the caller decides where the warning goes.
 */
export function evaluateTierMismatch(
  personality: PersonalityConfig,
  activeLlmName: string,
): string | undefined {
  const tierMap = personality.model;
  if (!tierMap || typeof tierMap !== 'object') return undefined;
  if (personality.provider === activeLlmName) return undefined;
  const tiers = Object.entries(tierMap)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([tier, model]) => `${tier}=${model}`)
    .join(', ');
  return (
    `personality \`${personality.id}\` declares model tiers (${tiers}) for provider ` +
    `"${personality.provider ?? '(none)'}", but the active LLM is "${activeLlmName}" — ` +
    'the tiers are inert and every turn falls through to the global model. ' +
    `Declare \`provider: ${activeLlmName}\` (with model ids that provider serves) ` +
    "in the personality's config.yaml to activate them."
  );
}
