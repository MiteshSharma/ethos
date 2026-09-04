import {
  type ResponsesApiBody,
  streamResponsesApi,
  toResponsesInput,
  toResponsesTools,
} from '@ethosagent/llm-codex';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// @ethosagent/llm-xai — xAI (Grok) on the OpenAI Responses API
// ---------------------------------------------------------------------------
//
//   AgentLoop
//      │  complete(messages, tools, options)
//      ▼
//   XaiProvider  (this file)
//      │  · resolves providers/xai/apiKey — the ref tools-x-search already uses
//      │  · pins baseUrl https://api.x.ai/v1, not overridable from config
//      │  · owns its capabilities object and its default model (grok-4.6)
//      │  · builds ResponsesApiBody:
//      │        model, input: toResponsesInput(messages),
//      │        stream: true, store: false,
//      │        tools: toResponsesTools(tools)
//      ▼
//   streamResponsesApi(endpoint, token, body, signal, requestTokens, 'xAI')
//   @ethosagent/llm-codex · transport.ts          ← REUSED per ARCHITECTURE.md:264-265
//      │  fetch → SSE parse → CompletionChunk map    ("a provider must not
//      │                                               contain a streaming loop")
//      ▼
//   AsyncIterable<CompletionChunk>   ← pinned by __tests__/conformance.test.ts
//
// UNVERIFIED — read this before trusting the request shape below. The live xAI
// Responses envelope has never been observed from this repo: no xAI API key was
// available when this package was written, so neither of the plan's two live
// probes was run. `streamResponsesApi` is proven against OPENAI's Responses
// implementation only, and extensions/tools-x-search/src/index.ts:76 carries the
// same self-declared gap for its own parsing of api.x.ai. This is open question 1
// of plan/phases/xai-grok-provider.md. What follows is the conservative reading
// of the vendor's documentation, not observed behaviour — record a fixture the
// first time a real response is seen, and revisit the omissions in `complete()`.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pinned. An xAI-named provider that resolves to another host authenticates an
 *  xAI key against a stranger; `baseUrl` from config is deliberately ignored. */
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const XAI_RESPONSES_ENDPOINT = `${XAI_BASE_URL}/responses`;

/** Seed only — the operator overrides it with `model:` in config (D2). xAI's
 *  roster moves (the coding model is `grok-build-0.1`; `grok-code` is stale), so
 *  this package validates nothing locally and lets the vendor be the authority. */
export const XAI_DEFAULT_MODEL = 'grok-4.6';

/** The EXISTING ref, already used by the `x_search` tool — one credential for
 *  the tool and the provider, never a second one. `XAI_API_KEY` resolves to it
 *  through `ENV_TO_REF` in packages/storage-fs/src/env-secrets.ts. */
export const XAI_SECRET_REF = 'providers/xai/apiKey';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface XaiProviderConfig {
  /** xAI model id, e.g. `grok-4.6`. */
  model: string;
  /** xAI API key (sent as `Authorization: Bearer`). */
  apiKey: string;
  /** Context window. Defaults to grok-4.6's 500K; the roster spans 256K
   *  (`grok-build-0.1`) to 1M (`grok-4.3`), so an operator on another model
   *  sets this. */
  maxContextTokens?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Rewrite an unrecognised-model failure into something the operator can act on.
 *
 * xAI answers an unknown model with a 404; surfaced raw it reads as a transport
 * fault and says nothing about which config key produced it. The rewritten
 * message keeps the `model_not_found` token so
 * `packages/core/src/providers/chained-provider.ts` still classifies it and can
 * fail over. Every other error passes through untouched.
 */
export function decorateModelError(err: unknown, model: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!/\b404\b|model[_ ]not[_ ]found|does not exist|no such model/i.test(message)) return err;
  return new Error(
    `xAI rejected model "${model}" (model_not_found). Set \`model:\` for the xai provider in ` +
      '~/.ethos/config.yaml to a current xAI model id (see https://docs.x.ai/docs/models). ' +
      `Upstream: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// XaiProvider
// ---------------------------------------------------------------------------

export class XaiProvider implements LLMProvider {
  readonly name = 'xai';
  readonly model: string;
  readonly maxContextTokens: number;
  /** No prompt caching: xAI needs a cache key that is STABLE across turns
   *  (`prompt_cache_key`), and `CompletionOptions` carries no session id — the
   *  request id minted in stream-step.ts is fresh every call. Threading one
   *  through is a contracts-layer change, deferred (D7). Consequences: Grok
   *  turns pay full input price, and `usage.cacheReadTokens` reads 0 for a known
   *  reason rather than a bug. */
  readonly supportsCaching = false;
  /** grok-4.6 reasons by default, but the shared Responses transport maps no
   *  reasoning event to `thinking_delta`, so nothing surfaces. Declaring `false`
   *  describes what a caller actually receives. */
  readonly supportsThinking = false;
  /** `toResponsesInput` flattens an image into a data-URI string inside a user
   *  message — a fallback, not vision support. Same call llm-codex makes. */
  readonly supportsVision = { images: false, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: false,
      thinking: false,
      promptCaching: false,
      // The Responses API takes the system prompt as the top-level
      // `instructions` field, not as a message with a `system` role.
      systemPromptStyle: 'top-level',
      // Advisory only: `ProviderCapabilities.stopSequences` has zero consumers
      // repo-wide (verified) — the four transports that handle stop sequences
      // all read `CompletionOptions.stopSequences`, a different field. The
      // protection that actually holds is the wire-level omission in
      // `complete()` below; this flag is here for the reader.
      stopSequences: false,
      tokenCounting: 'estimated',
      contractVersion: 1,
    };
  }

  private readonly apiKey: string;

  constructor(config: XaiProviderConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.maxContextTokens = config.maxContextTokens ?? 500_000;
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const effectiveModel = options.modelOverride ?? this.model;

    const body: ResponsesApiBody = {
      model: effectiveModel,
      input: toResponsesInput(messages),
      stream: true,
      // Data residency, not capability (D6). `store: true` retains request and
      // response content on a third party's servers for 30 days, in a framework
      // that is local-first and already owns the transcript via
      // extensions/session-sqlite. There is no tradeoff with reasoning here —
      // llm-codex ships `store: false` alongside `include` today — but `include:
      // ['reasoning.encrypted_content']` is omitted because nothing reads
      // reasoning back across turns, and an unread blob is payload we pay to
      // move. Add it when there is a consumer.
      store: false,
    };

    if (options.system) {
      body.instructions = options.system;
    }

    const responsesTools = toResponsesTools(tools);
    if (responsesTools.length > 0) {
      body.tools = responsesTools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    // Nothing from `options` is forwarded as a sampling parameter, deliberately:
    //
    //   · `stop`, `presence_penalty`, `frequency_penalty` — xAI's reasoning
    //     models REJECT these with an error, not a warning, and grok-4.6 reasons
    //     by default. The penalties are a forward-looking guard (no transport in
    //     this repo can emit them today); `stop` is the reachable one, since a
    //     caller can set `CompletionOptions.stopSequences`.
    //   · `temperature`, `top_p`, `seed` — reachable from a caller AND, without
    //     anyone asking, from a model row's sampling `profile` via
    //     `applySamplingDefaults` (packages/core/src/agent-loop/sampling.ts).
    //     Whether grok-4.6 accepts them is the plan's open question 2 and NO
    //     LIVE PROBE HAS RUN. Omitting them is the conservative choice; forward
    //     them only once a real 200 says they are accepted.
    //
    // `options.maxTokens` is also not forwarded: the Responses API spells it
    // `max_output_tokens` (a third name for the concept), and the shared
    // `ResponsesApiBody` has no field for it.

    // Per-slice token estimate (best-effort, mirrors the other providers).
    let requestTokens: { system: number; tools: number; messages: number } | undefined;
    try {
      const systemText = options.system ?? '';
      const toolsText = responsesTools.length > 0 ? JSON.stringify(responsesTools) : '';
      requestTokens = {
        system: Math.ceil(systemText.length / 4),
        tools: Math.ceil(toolsText.length / 4),
        messages: await this.countTokens(messages),
      };
    } catch {
      // Best-effort: if counting fails, requestTokens stays undefined.
    }

    try {
      // 'xAI' is the vendor label the shared transport puts in its failure
      // messages — an xAI 401 reported as a Codex error sends the operator to
      // the wrong console.
      yield* streamResponsesApi(
        XAI_RESPONSES_ENDPOINT,
        this.apiKey,
        body,
        options.abortSignal,
        requestTokens,
        'xAI',
      );
    } catch (err) {
      throw decorateModelError(err, effectiveModel);
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // xAI exposes a tokenize endpoint, but calling it would cost a round trip
    // per turn; same ~4 chars/token approximation as the other providers.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const xaiFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  const secretKey = await secrets.get(XAI_SECRET_REF);
  const apiKey = secretKey ?? (cfg.apiKey as string | undefined);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      `Using plaintext apiKey from config for xai; migrate to the secret store: ethos secrets set ${XAI_SECRET_REF} <key>`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `xAI provider requires an API key. Set it with \`ethos secrets set ${XAI_SECRET_REF} <key>\`, ` +
        'or export XAI_API_KEY (which resolves to the same ref). The same key serves the x_search tool.',
    );
  }
  if (cfg.baseUrl && cfg.baseUrl !== XAI_BASE_URL) {
    logger.warn(
      `Ignoring baseUrl "${String(cfg.baseUrl)}" for the xai provider — it is pinned to ${XAI_BASE_URL}. ` +
        'Front a gateway or aggregator with the openai-compat provider instead.',
    );
  }
  const maxContextTokens = cfg.maxContextTokens as number | undefined;
  return new XaiProvider({
    model: (cfg.model as string | undefined) ?? XAI_DEFAULT_MODEL,
    apiKey,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('xai', xaiFactory);
}
