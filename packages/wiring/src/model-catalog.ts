import type { ModelProfile } from '@ethosagent/types';

export type { ModelProfile, ModelSampling } from '@ethosagent/types';

export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
  /** §7 keystone — optional per-model profile (sampling defaults, tool-call
   *  format, output-token cap). Absent for models without a profile, in which
   *  case no defaults are applied and behavior is byte-identical to today. */
  profile?: ModelProfile;
}

/** Context window below which a warning is shown in the model picker. */
export const MIN_CONTEXT_WINDOW = 64_000;

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Anthropic
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    label: 'most capable',
    contextWindow: 200_000,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    label: 'fast, balanced',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    label: 'cheapest, fast',
    contextWindow: 200_000,
  },
  // OpenAI
  {
    providerId: 'openai',
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-pro',
    label: 'most capable frontier',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-nano',
    label: 'ultra-efficient at scale',
    contextWindow: 200_000,
  },
  { providerId: 'openai', modelId: 'o3', label: 'reasoning', contextWindow: 200_000 },
  {
    providerId: 'openai',
    modelId: 'o3-pro',
    label: 'reasoning, most capable',
    contextWindow: 200_000,
  },
  { providerId: 'openai', modelId: 'o3-mini', label: 'reasoning, fast', contextWindow: 200_000 },
  { providerId: 'openai', modelId: 'o1', label: 'reasoning, prior gen', contextWindow: 200_000 },
  {
    providerId: 'openai',
    modelId: 'o1-mini',
    label: 'reasoning, prior gen mini',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'o1-preview',
    label: 'reasoning, preview',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128_000,
  },
  { providerId: 'openai', modelId: 'gpt-4o-mini', label: 'fast, cheap', contextWindow: 128_000 },
  // OpenRouter top picks
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-opus-4-7',
    label: 'Claude Opus',
    contextWindow: 200_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2',
    contextWindow: 131_072,
  },
  // Azure AI Foundry — source: https://ai.azure.com/catalog/models
  // The `modelId` is the deployment name in Azure. By convention Azure admins
  // name a deployment after the base model. If yours uses a custom name
  // (e.g. `prod-chat-v2`), pick any entry here and edit `model:` in
  // ~/.ethos/config.yaml. Context windows are nominal; verify per-deployment.
  {
    providerId: 'azure',
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-pro',
    label: 'most capable frontier',
    contextWindow: 200_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 128_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-nano',
    label: 'ultra-efficient at scale',
    contextWindow: 128_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-opus-4-6',
    label: 'Claude Opus on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'DeepSeek-V4-Pro',
    label: 'reasoning MoE',
    contextWindow: 1_000_000,
  },
  // Gemini
  {
    providerId: 'gemini',
    modelId: 'gemini-2.5-pro',
    label: 'most capable',
    contextWindow: 1_000_000,
    default: true,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-2.0-flash',
    label: 'fast, cheap',
    contextWindow: 1_000_000,
  },
  // Groq
  {
    providerId: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    label: 'LLaMA 3.3 70B',
    contextWindow: 32_768,
    default: true,
  },
  {
    providerId: 'groq',
    modelId: 'llama-3.1-8b-instant',
    label: 'fastest, cheapest',
    contextWindow: 131_072,
  },
  {
    providerId: 'groq',
    modelId: 'deepseek-r1-distill-llama-70b',
    label: 'reasoning, distilled',
    contextWindow: 128_000,
  },
  {
    providerId: 'groq',
    modelId: 'mixtral-8x7b-32768',
    label: 'Mixtral 8x7B MoE',
    contextWindow: 32_768,
  },
  { providerId: 'groq', modelId: 'gemma2-9b-it', label: 'Gemma 2 9B', contextWindow: 8_192 },
  // DeepSeek
  {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    label: 'best balance',
    contextWindow: 64_000,
    default: true,
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek-reasoner',
    label: 'reasoning model',
    contextWindow: 64_000,
  },
  // Ollama
  {
    providerId: 'ollama',
    modelId: 'llama3.2',
    label: '3B, fast',
    // Llama 3.2 (1B/3B) supports a 128k context window. Kept realistic so the
    // default local model clears the Phase 1d 16k agentic-tool-use floor (a
    // silently-tiny Ollama num_ctx still fails loudly at provider init).
    contextWindow: 131_072,
    default: true,
  },
  { providerId: 'ollama', modelId: 'mistral', label: '7B', contextWindow: 32_768 },
  // Lane 0 — commonly-run Ollama models. contextWindow values are conservative
  // ARCHITECTURE maxima; the Lane 0 resolution caps catalog values for local
  // runtimes at ARCH_WINDOW_CAP_TOKENS (32,768, local-models.ts) because the
  // SERVED window is whatever num_ctx Ollama allocated — the /api/ps probe
  // reports the truth, and these rows are only the fallback behind it.
  { providerId: 'ollama', modelId: 'qwen3', label: '8B, hybrid reasoning', contextWindow: 40_960 },
  { providerId: 'ollama', modelId: 'gemma3', label: '4B, multimodal', contextWindow: 131_072 },
  { providerId: 'ollama', modelId: 'phi4', label: '14B', contextWindow: 16_384 },
  {
    providerId: 'ollama',
    modelId: 'deepseek-r1',
    label: 'reasoning, distilled',
    contextWindow: 131_072,
  },
  { providerId: 'ollama', modelId: 'llama3.3', label: '70B', contextWindow: 131_072 },
  // Mistral — direct API. baseUrl: https://api.mistral.ai/v1
  // Set `baseUrl` in ~/.ethos/config.yaml; OpenAICompatProvider handles the
  // rest. Context windows are nominal — verify against the official pricing
  // page if a deployment behaves smaller than expected.
  {
    providerId: 'mistral',
    modelId: 'mistral-large-latest',
    label: 'most capable',
    contextWindow: 128_000,
    default: true,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-medium-latest',
    label: 'fast, balanced',
    contextWindow: 128_000,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-small-latest',
    label: 'cheapest, fast',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'codestral-latest',
    label: 'code-specialized',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'pixtral-large-latest',
    label: 'vision',
    contextWindow: 128_000,
  },
  {
    providerId: 'mistral',
    modelId: 'ministral-8b-latest',
    label: 'compact',
    contextWindow: 128_000,
  },
  // Together AI — direct API. baseUrl: https://api.together.xyz/v1
  // Model IDs are namespaced (`vendor/model-name`) and required verbatim.
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
    label: 'Llama 3.1 405B Turbo',
    contextWindow: 130_000,
    default: true,
  },
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    label: 'Llama 3.1 70B Turbo',
    contextWindow: 130_000,
  },
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    label: 'Llama 3.1 8B Turbo',
    contextWindow: 130_000,
  },
  {
    providerId: 'together',
    modelId: 'mistralai/Mixtral-8x22B-Instruct-v0.1',
    label: 'Mixtral 8x22B',
    contextWindow: 65_536,
  },
  {
    providerId: 'together',
    modelId: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
    label: 'Qwen 2.5 72B Turbo',
    contextWindow: 32_768,
  },
  {
    providerId: 'together',
    modelId: 'deepseek-ai/DeepSeek-V3',
    label: 'DeepSeek V3',
    contextWindow: 128_000,
  },
  // Fireworks AI — direct API. baseUrl: https://api.fireworks.ai/inference/v1
  // The `accounts/fireworks/models/` prefix is canonical and required.
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    label: 'Llama 3.3 70B',
    contextWindow: 128_000,
    default: true,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/qwen2p5-72b-instruct',
    label: 'Qwen 2.5 72B',
    contextWindow: 32_768,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/deepseek-v3',
    label: 'DeepSeek V3',
    contextWindow: 128_000,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/firefunction-v2',
    label: 'FireFunction v2',
    contextWindow: 8_192,
  },
  // Codex (OpenAI device auth)
  {
    providerId: 'codex',
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.3-codex',
    label: 'code-specialized',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.2-codex',
    label: 'code-specialized, prior gen',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-max',
    label: 'max context, prior gen',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-mini',
    label: 'compact, prior gen',
    contextWindow: 200_000,
  },
  // xAI Grok — direct API. baseUrl: https://api.x.ai/v1
  // No sampling `profile` on any of these rows, deliberately: whether Grok
  // accepts `temperature`, `top_p` and `seed` is unverified against a live
  // endpoint (xai-grok-provider open question 2), and `applySamplingDefaults`
  // would put a catalog profile's values on the wire on every turn. Add a
  // profile only once that probe passes.
  {
    providerId: 'xai',
    modelId: 'grok-4.6',
    label: 'most capable',
    contextWindow: 500_000,
    default: true,
  },
  { providerId: 'xai', modelId: 'grok-4.5', label: 'prior gen', contextWindow: 500_000 },
  {
    providerId: 'xai',
    modelId: 'grok-4.3',
    label: 'long context, cheaper',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'xai',
    modelId: 'grok-build-0.1',
    label: 'code-specialized',
    contextWindow: 256_000,
  },
];

/**
 * Lane 0 — provider-level window defaults for runtimes whose model set is
 * operator-defined. vLLM serves whatever `--max-model-len` the operator set at
 * launch, so there is no honest per-model catalog row — the probe reads the
 * real `max_model_len` from `GET /v1/models`, and this default is only the
 * conservative fallback when both the probe and explicit config are silent.
 * (32,768 = ARCH_WINDOW_CAP_TOKENS — already at the local architecture cap,
 * so the cap never has to fire on it.)
 */
export const PROVIDER_WINDOW_DEFAULTS: Record<string, number> = {
  vllm: 32_768,
};

export function getModelsForProvider(providerId: string): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

/**
 * Look up the context window for a `(providerId, modelId)` pair. Returns
 * `undefined` on a miss so callers can fall back to the provider default rather
 * than crash. Shared by the model picker and the provider factories so the
 * lookup lives in exactly one place (M1b).
 */
export function lookupContextWindow(providerId: string, modelId: string): number | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)
    ?.contextWindow;
}

/**
 * Look up the per-model `profile` for a `(providerId, modelId)` pair. Same
 * lookup shape as {@link lookupContextWindow} (DRY). Returns `undefined` on a
 * miss OR when the entry carries no profile — callers then apply no defaults.
 */
export function lookupProfile(providerId: string, modelId: string): ModelProfile | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)?.profile;
}

/**
 * Merge a config `models:` override OVER a catalog `profile`. The override wins
 * field-by-field (per-key for sampling). Precedence within §7: config override
 * beats catalog. Returns `undefined` when neither side sets anything.
 */
export function mergeModelProfile(
  base: ModelProfile | undefined,
  override: ModelProfile | undefined,
): ModelProfile | undefined {
  if (!base && !override) return undefined;
  const merged: ModelProfile = {};
  const sampling = { ...base?.sampling, ...override?.sampling };
  if (Object.keys(sampling).length > 0) merged.sampling = sampling;
  const toolCallFormat = override?.toolCallFormat ?? base?.toolCallFormat;
  if (toolCallFormat !== undefined) merged.toolCallFormat = toolCallFormat;
  const maxOutputTokens = override?.maxOutputTokens ?? base?.maxOutputTokens;
  if (maxOutputTokens !== undefined) merged.maxOutputTokens = maxOutputTokens;
  const structuredOutput = override?.structuredOutput ?? base?.structuredOutput;
  if (structuredOutput !== undefined) merged.structuredOutput = structuredOutput;
  const parseThinkTags = override?.parseThinkTags ?? base?.parseThinkTags;
  if (parseThinkTags !== undefined) merged.parseThinkTags = parseThinkTags;
  // §5 — merge compaction per-field (override wins per key) so a partial
  // override (e.g. only `pressure`) keeps the base `target`.
  const compaction = { ...base?.compaction, ...override?.compaction };
  if (Object.keys(compaction).length > 0) merged.compaction = compaction;
  const charsPerToken = override?.charsPerToken ?? base?.charsPerToken;
  if (charsPerToken !== undefined) merged.charsPerToken = charsPerToken;
  // §2 — merge promptBudget per-field (override wins per key) so a partial
  // override keeps the base's other knobs.
  const promptBudget = { ...base?.promptBudget, ...override?.promptBudget };
  if (Object.keys(promptBudget).length > 0) merged.promptBudget = promptBudget;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * §5 — resolve the effective compaction gate config for a model. Precedence:
 * per-model `profile.compaction` > global `compaction:` config > the gate's
 * hardcoded 0.8/0.7 defaults (applied downstream in the gate, so both-absent
 * yields `undefined` here and the gate stays byte-identical to today).
 * `charsPerToken` is per-model only. Returns `undefined` when nothing is set.
 */
export function resolveCompactionGate(
  profile: ModelProfile | undefined,
  global: { pressure?: number; target?: number } | undefined,
): { pressure?: number; target?: number; charsPerToken?: number } | undefined {
  const pressure = profile?.compaction?.pressure ?? global?.pressure;
  const target = profile?.compaction?.target ?? global?.target;
  const charsPerToken = profile?.charsPerToken;
  if (pressure === undefined && target === undefined && charsPerToken === undefined) {
    return undefined;
  }
  return {
    ...(pressure !== undefined ? { pressure } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(charsPerToken !== undefined ? { charsPerToken } : {}),
  };
}

/**
 * Window (tokens) at or above which a model counts as "frontier" for the
 * purpose of picking a default context engine. Below it — mid / small / local —
 * we never DEFAULT to LLM self-summarization; deterministic `drop_oldest` (plus
 * the always-on Phase 1 tool-result aging) carries the load instead.
 */
export const FRONTIER_WINDOW_TOKENS = 128_000;

/**
 * Phase 3 — per-model-class default context engine, used only when the
 * personality declares no `context_engine`. Frontier models with a wired
 * summarizer (`auxiliary.compression.model`) default to `semantic_summary`;
 * everything else — mid, small, and local models — defaults to `drop_oldest`.
 * This keeps weak/local models on deterministic reductions.
 */
export function resolveDefaultContextEngine(
  contextWindow: number | undefined,
  summarizerWired: boolean,
): 'semantic_summary' | 'drop_oldest' {
  const window = contextWindow ?? 0;
  if (summarizerWired && window >= FRONTIER_WINDOW_TOKENS) return 'semantic_summary';
  return 'drop_oldest';
}

/**
 * Phase 4 — a model at or below this window always enters small-window mode.
 * Below ~32k the fixed prompt overhead (SOUL + tools) leaves too little room
 * for history; the mode swaps to index-not-content memory, a compact prelude,
 * forced-index skills, and a scaled history limit.
 */
export const SMALL_WINDOW_MAX_TOKENS = 32_000;

/**
 * Phase 4 — ratio trigger. On a LARGER window, small-window mode still activates
 * when the measured static sections (system + tools) exceed this fraction of the
 * window — the "big SOUL / big toolset on a mid model" case a fixed 32k cutoff
 * would miss.
 */
export const SMALL_WINDOW_STATIC_RATIO = 0.4;

/**
 * Phase 4 — decide whether small-window mode is active. Pure and static-input
 * only (window + measured static overhead), so the decision is resolved ONCE per
 * loop and never varies per turn — the prompt prefix stays byte-stable.
 * `override` from config forces the mode on/off; `auto` (default) applies the
 * window + ratio triggers.
 */
export function resolveSmallWindowMode(opts: {
  contextWindow: number | undefined;
  staticTokens: number;
  override?: 'auto' | 'on' | 'off';
}): boolean {
  if (opts.override === 'on') return true;
  if (opts.override === 'off') return false;
  const window = opts.contextWindow ?? 0;
  if (window <= 0) return false;
  if (window <= SMALL_WINDOW_MAX_TOKENS) return true;
  return opts.staticTokens / window > SMALL_WINDOW_STATIC_RATIO;
}

/**
 * Phase 4 — scale the history message limit to the window. Frontier windows keep
 * the default 200; smaller windows get proportionally fewer messages
 * (~1 per 400 tokens), clamped to [40, 200] so a tiny window still keeps a
 * usable recent tail.
 */
export function scaleHistoryLimit(contextWindow: number | undefined): number {
  const window = contextWindow ?? 0;
  if (window <= 0 || window >= FRONTIER_WINDOW_TOKENS) return 200;
  return Math.min(200, Math.max(40, Math.round(window / 400)));
}

export function getDefaultModel(providerId: string): ModelCatalogEntry | undefined {
  const models = getModelsForProvider(providerId);
  return models.find((m) => m.default) ?? models[0];
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`;
  return `${Math.round(tokens / 1_000)}k ctx`;
}
