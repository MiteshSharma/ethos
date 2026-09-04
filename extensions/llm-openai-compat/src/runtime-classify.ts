// Post-review FIX 2 — hardened local-runtime classification, in ONE place.
//
// The `(providerName, baseUrl)` → local-runtime classification drives real
// policy: the Lane 3 schema sanitizer, the 32k architecture window cap, the
// payload-guard 'fail' severity, the 16k context floor, and <think>-tag
// parsing. A port heuristic alone is not enough to claim "local": a hosted
// alias (openrouter/groq/deepseek/…) routed through a corporate proxy on
// :8080 must NEVER be reclassified as llama.cpp. The rule:
//
//   1. Local names classify by NAME (the configured alias is authoritative).
//   2. Known HOSTED alias names never classify as local, regardless of port.
//   3. Port heuristics fire only for generic/unrecognized names
//      ('openai-compat', custom names) — and fail soft: probing a wrong
//      server 404s and resolves to "unknown window", never a wrong one.
//
// `packages/wiring/src/local-models.ts` (`detectLocalRuntime`) delegates to
// this function so wiring and the provider can never disagree.

/** Local runtimes the classification (and the window probe) knows about. */
export type LocalOpenAiRuntime = 'ollama' | 'vllm' | 'llamacpp' | 'lmstudio';

/**
 * Provider alias names that are ALWAYS hosted. A baseUrl override (proxy,
 * gateway, region endpoint) never makes these local — see FIX 2 rule above.
 * Mirrors the built-in provider registrations + the setup provider catalog.
 */
export const HOSTED_PROVIDER_ALIASES: ReadonlySet<string> = new Set([
  'openai',
  'openrouter',
  'gemini',
  'gemini-native',
  'groq',
  'deepseek',
  'azure',
  'codex',
  'anthropic',
  'bedrock',
  'mistral',
  'together',
  'fireworks',
  // xAI is served by its own extension (@ethosagent/llm-xai), which pins
  // https://api.x.ai/v1. `detectLocalRuntime` is still called with the CONFIG's
  // baseUrl (packages/wiring/src/index.ts), so a leftover or proxied
  // `baseUrl:` on :11434/:1234/:8080 would otherwise classify a paid hosted
  // provider as a local runtime — silently costing $0 and taking the local
  // context-window path.
  'xai',
]);

/**
 * Classify a `(providerName, baseUrl)` pair as a local OpenAI-compat runtime,
 * or `undefined` for anything hosted or unrecognized.
 */
export function classifyLocalRuntime(
  providerName: string,
  baseUrl: string,
): LocalOpenAiRuntime | undefined {
  const n = providerName.toLowerCase();
  if (n === 'ollama') return 'ollama';
  if (n === 'vllm') return 'vllm';
  if (n === 'llamacpp' || n === 'llama.cpp' || n === 'llama-cpp') return 'llamacpp';
  if (n === 'lmstudio' || n === 'lm-studio') return 'lmstudio';
  // FIX 2 — a known hosted alias NEVER classifies as local, regardless of
  // what port its (possibly proxied) baseUrl happens to use.
  if (HOSTED_PROVIDER_ALIASES.has(n)) return undefined;
  if (baseUrl.includes(':11434')) return 'ollama'; // Ollama default port
  if (baseUrl.includes(':1234')) return 'lmstudio'; // LM Studio default port
  if (baseUrl.includes(':8080')) return 'llamacpp'; // llama.cpp server default port
  return undefined;
}
