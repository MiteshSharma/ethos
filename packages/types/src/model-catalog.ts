/**
 * Sampling knobs for a per-model profile (§7). `temperature`/`topP` map to
 * `CompletionOptions` fields; `topK`/`minP` are NOT in the frozen
 * `CompletionOptions` and ride `CompletionOptions.providerOptions` instead.
 */
export interface ModelSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

/**
 * Per-model config profile (§7 keystone, minimal). Only fields with a live
 * consumer today: sampling defaults, tool-call transport format, and an
 * output-token cap. Later phases add their own fields (structuredOutput,
 * promptBudget, compaction thresholds, charsPerToken, thinking).
 */
export interface ModelProfile {
  sampling?: ModelSampling;
  toolCallFormat?: 'openai' | 'text-xml';
  maxOutputTokens?: number;
  /** §3 — when true, wiring sets `ProviderCapabilities.structuredOutput` so
   *  internal JSON consumers request grammar-constrained decoding. Absent →
   *  capability stays unset (models without native structured output). */
  structuredOutput?: boolean;
  /** §5 — per-model compaction gate thresholds, as fractions of the model's
   *  window in (0,1]. `pressure` is the gate (compact above it); `target` is
   *  what compaction aims to shrink to. Both override the global `compaction:`
   *  config, which overrides the hardcoded 0.8/0.7 defaults. Absent →
   *  global/default applies (behavior unchanged). */
  compaction?: { pressure?: number; target?: number };
  /** §5 — gate estimator divisor (chars per token) for THIS model. Local
   *  tokenizers diverge from the char/4 rule of thumb. When set, the compaction
   *  gate divides characters by this value INSTEAD of char/4 and skips the
   *  generic small-window safety factor (this is the accurate per-model value —
   *  inflating it would double-count). Absent → char/4 + small-window factor
   *  (unchanged). The engine-only `countTokens` is untouched. */
  charsPerToken?: number;
  /** §2 — prompt-economy knobs for lean (small-context) models. Applied in
   *  context assembly. Absent → assembly is byte-identical to today.
   *  - `compactPrelude`: use the short injection-defense prelude variant.
   *  - `memorySnapshotCap`: cap the memory block at N chars (overrides ≤20,000).
   *  - `suppressMemoryGuidance`: omit the memory-usage guidance block. */
  promptBudget?: {
    compactPrelude?: boolean;
    memorySnapshotCap?: number;
    suppressMemoryGuidance?: boolean;
  };
  /** Post-review FIX 5 — explicit `<think>…</think>` TAG-parsing override for
   *  the openai-compat provider. Absent → the provider derives it from the
   *  hardened local-runtime classification (local → parse, hosted → pass
   *  through verbatim). Set `true` to opt a hosted reasoning model in. */
  parseThinkTags?: boolean;
}

export interface ModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  default?: boolean;
  /** Optional per-model profile carried through the remote manifest. Absent on
   *  old manifests — they stay valid. */
  profile?: ModelProfile;
}

export interface ProviderCatalog {
  models: ModelEntry[];
}

export interface ModelCatalogManifest {
  version: number;
  updatedAt: string;
  providers: Record<string, ProviderCatalog>;
}
