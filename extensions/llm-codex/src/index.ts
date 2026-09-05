import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Logger,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { discoverModelsCached, modelRejectionHint, unsupportedModelMessage } from './models';
import { toResponsesInput, toResponsesTools } from './responses-adapter';
import { type ResponsesApiBody, ResponsesApiError, streamResponsesApi } from './transport';

export type { CodexCredentials } from './auth';
export { exchangeForTokens, pollForAuthorization, requestDeviceCode } from './auth';
export {
  CODEX_FALLBACK_MODELS,
  CODEX_MODELS_URL,
  discoverModels,
  type ModelDiscovery,
  resetModelDiscoveryCache,
  unsupportedModelMessage,
} from './models';
export { toResponsesInput, toResponsesTools } from './responses-adapter';
export { CodexTokenStore } from './token-store';
export { type ResponsesApiBody, ResponsesApiError, streamResponsesApi } from './transport';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodexProviderConfig {
  model: string;
  getAccessToken: () => Promise<string>;
  maxContextTokens?: number;
  /** Non-fatal diagnostics — today, the configured model not being on this
   *  account's roster. Absent → silent. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// ---------------------------------------------------------------------------
// CodexProvider
// ---------------------------------------------------------------------------

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: false, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    };
  }

  private readonly getAccessToken: () => Promise<string>;
  private readonly logger: Logger | undefined;
  private modelChecked = false;

  constructor(config: CodexProviderConfig) {
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.getAccessToken = config.getAccessToken;
    this.logger = config.logger;
  }

  /**
   * First-turn check: warn when the configured model is not on the account's
   * live roster. OpenAI still rejects the request with a 400 — this only puts
   * the fix in front of the operator before that happens. The fallback roster
   * is a guess, not proof, so it never produces a warning.
   */
  private async checkModelOnce(token: string): Promise<void> {
    if (this.modelChecked) return;
    this.modelChecked = true;
    const discovery = await discoverModelsCached(token);
    if (discovery.source !== 'live' || discovery.models.includes(this.model)) return;
    this.logger?.warn(unsupportedModelMessage(this.model, discovery.models));
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const token = await this.getAccessToken();
    await this.checkModelOnce(token);
    const effectiveModel = options.modelOverride ?? this.model;

    const body: ResponsesApiBody = {
      model: effectiveModel,
      input: toResponsesInput(messages),
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
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

    // The Codex Responses API rejects `max_output_tokens` with a 400
    // ("Unsupported parameter") — output length is managed server-side, so
    // `options.maxTokens` is intentionally not forwarded.

    // Per-slice token estimate (best-effort, mirrors other providers).
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
      yield* streamResponsesApi(
        RESPONSES_ENDPOINT,
        token,
        body,
        options.abortSignal,
        requestTokens,
        'Codex',
      );
    } catch (err) {
      // A model rejection reads as a bare 400 in the chat UI; append the
      // account's roster so the fix is inline. Every other error passes through.
      if (err instanceof ResponsesApiError && err.status === 400) {
        const hint = modelRejectionHint(err.body, effectiveModel);
        if (hint) throw new Error(`${err.message} — ${hint}`);
      }
      throw err;
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // No token-counting API available — rough character-based estimate.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation (§9.2 — dogfooding the plugin SDK)
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';
import { CodexTokenStore } from './token-store';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const codexFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  const store = new CodexTokenStore(secrets);
  return new CodexProvider({
    model: cfg.model as string,
    getAccessToken: async () => {
      const creds = await store.ensureValid(globalThis.fetch);
      return creds.accessToken;
    },
    logger,
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('codex', codexFactory);
}
