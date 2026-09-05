import { validateUrl } from '@ethosagent/core';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import type { SecretsResolver } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import type { OnboardingStep, ProviderId } from '@ethosagent/web-contracts';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import type { ConfigRepository } from '../repositories/config.repository';

// Onboarding orchestration. Three RPCs:
//
//   • state             — derives the current step from disk: missing config
//                         → 'welcome'; provider+key set, no personality
//                         chosen yet → 'personality'; etc.
//   • validateProvider  — calls the provider's models endpoint with the
//                         supplied key. Returns the model list for the
//                         step-2 picker, or a normalised error string.
//   • complete          — writes provider/key/model/personality to
//                         ~/.ethos/config.yaml in one shot.
//
// All four supported providers go through one fetch helper — Anthropic +
// Ollama need slightly different request shapes; OpenRouter and OpenAI-
// compat use the OpenAI `GET /v1/models` envelope.

export interface OnboardingState {
  step: OnboardingStep;
  hasProvider: boolean;
  selectedPersonalityId: string | null;
}

export interface ValidateProviderInput {
  provider: ProviderId;
  apiKey: string;
  baseUrl?: string;
}

export interface ValidateProviderResult {
  ok: boolean;
  models: string[] | null;
  error: string | null;
  completionTested: boolean;
}

export interface CompleteInput {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  personalityId: string;
}

export interface OnboardingServiceOptions {
  config: ConfigRepository;
  personalities: FilePersonalityRegistry;
  /** Secret store — used to check Codex OAuth tokens during validation. */
  secrets: SecretsResolver;
  /** Inject for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Fired after `complete()` durably writes config.yaml. Fire-and-forget —
   *  exceptions are swallowed so a callback failure can't fail the RPC. */
  onSetupComplete?: () => void;
}

/** Mirrors `XAI_BASE_URL` in `@ethosagent/llm-xai`. Inlined rather than
 *  imported so validation keeps no runtime dep on the provider package —
 *  every other provider's endpoint is a literal here too. */
const XAI_BASE_URL = 'https://api.x.ai/v1';

const MODELS_TIMEOUT_MS = 8_000;
const COMPLETION_TIMEOUT_MS = 10_000;

export class OnboardingService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OnboardingServiceOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async state(): Promise<OnboardingState> {
    const raw = await this.opts.config.read();
    const hasProvider = !!(raw?.provider && (raw.apiKey || raw.provider === 'codex'));
    const personalityId = raw?.personality ?? null;

    if (!raw) return { step: 'welcome', hasProvider: false, selectedPersonalityId: null };
    if (!hasProvider) return { step: 'provider', hasProvider: false, selectedPersonalityId: null };
    if (!personalityId) return { step: 'personality', hasProvider, selectedPersonalityId: null };
    // Provider + personality both set → done. Front-end may still show the
    // "first turn" magic moment but that's a UI concern, not a config gate.
    return { step: 'done', hasProvider, selectedPersonalityId: personalityId };
  }

  async validateProvider(input: ValidateProviderInput): Promise<ValidateProviderResult> {
    // Codex uses device auth — check tokens exist, then ask the account which
    // models it can use. `discoverModels` falls back to the static roster on
    // any failure, so the picker is never empty.
    if (input.provider === 'codex') {
      const { CodexTokenStore, discoverModels } = await import('@ethosagent/llm-codex');
      const store = new CodexTokenStore(this.opts.secrets);
      const tokens = await store.load();
      if (!tokens) {
        return {
          ok: false,
          models: null,
          error: 'Codex not authorized — complete device auth first.',
          completionTested: false,
        };
      }
      const { models } = await discoverModels(tokens.accessToken, this.fetchFn);
      return { ok: true, models, error: null, completionTested: false };
    }

    try {
      const models = await this.fetchModels(input);
      if (input.provider === 'ollama') {
        return { ok: true, models, error: null, completionTested: false };
      }
      const chatModel = this.pickChatModel(input.provider, models);
      if (!chatModel) {
        return { ok: true, models, error: null, completionTested: false };
      }
      try {
        await this.testCompletion(input, chatModel);
        return { ok: true, models, error: null, completionTested: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isBillingError = message.includes('no credits');
        if (isBillingError) {
          return { ok: false, models, error: message, completionTested: false };
        }
        return { ok: true, models, error: null, completionTested: false };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, models: null, error: message, completionTested: false };
    }
  }

  async complete(input: CompleteInput): Promise<void> {
    if (!this.opts.personalities.get(input.personalityId)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${input.personalityId}" not found`,
        action: 'Pick from the list returned by `personalities.list`.',
      });
    }
    await this.opts.config.update({
      provider: input.provider,
      model: input.model,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      personality: input.personalityId,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    });
    try {
      this.opts.onSetupComplete?.();
    } catch {
      // Fire-and-forget — a callback failure must not fail onboarding.
    }
  }

  // ---------------------------------------------------------------------------
  // Chat model selection
  // ---------------------------------------------------------------------------

  private pickChatModel(provider: ProviderId, models: string[]): string | null {
    if (models.length === 0) return null;
    switch (provider) {
      case 'anthropic':
        return models.find((m) => m.startsWith('claude-')) ?? models[0] ?? null;
      case 'openai':
        return (
          models.find(
            (m) =>
              m.startsWith('gpt-') ||
              m.startsWith('o1-') ||
              m.startsWith('o3-') ||
              m.startsWith('o4-'),
          ) ??
          models[0] ??
          null
        );
      case 'codex': {
        // Prefer the catalog default when the account's live list carries it;
        // otherwise the first id the transport reported.
        const preferred = getDefaultModel('codex')?.modelId;
        return (preferred && models.includes(preferred) ? preferred : models[0]) ?? null;
      }
      default:
        return (
          models.find(
            (m) =>
              m.includes('chat') ||
              m.includes('gpt') ||
              m.includes('claude') ||
              m.includes('grok') ||
              m.includes('llama') ||
              m.includes('mistral') ||
              m.includes('gemma'),
          ) ??
          models[0] ??
          null
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Provider model-list fetchers
  // ---------------------------------------------------------------------------

  private async fetchModels(input: ValidateProviderInput): Promise<string[]> {
    if (input.baseUrl) {
      validateUrl(input.baseUrl, {
        allowLocalhost: input.provider === 'ollama',
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    try {
      switch (input.provider) {
        case 'anthropic':
          return await this.anthropicModels(input.apiKey, controller.signal);
        case 'ollama':
          return await this.ollamaModels(
            input.baseUrl ?? 'http://localhost:11434',
            controller.signal,
          );
        case 'openrouter':
          return await this.openAiCompatibleModels(
            input.baseUrl ?? 'https://openrouter.ai/api/v1',
            input.apiKey,
            controller.signal,
          );
        case 'openai':
          return await this.openAiCompatibleModels(
            input.baseUrl ?? 'https://api.openai.com/v1',
            input.apiKey,
            controller.signal,
          );
        case 'openai-compat':
          if (!input.baseUrl) throw new Error('baseUrl required for openai-compat');
          return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
        case 'azure':
          if (!input.baseUrl) throw new Error('baseUrl required for azure');
          return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
        case 'xai':
          // Hardcoded, not `input.baseUrl ?? default` like openrouter/openai:
          // the xai provider pins XAI_BASE_URL and ignores a configured
          // baseUrl, so honouring one here would validate a key against an
          // endpoint the agent will never actually call.
          return await this.openAiCompatibleModels(XAI_BASE_URL, input.apiKey, controller.signal);
        case 'codex':
          throw new Error('Codex uses device auth — call validateProvider directly');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async anthropicModels(apiKey: string, signal: AbortSignal): Promise<string[]> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
    });
    if (!res.ok) throw new Error(`anthropic returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private isAzureUrl(url: string): boolean {
    return url.includes('azure.com');
  }

  private async openAiCompatibleModels(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const base = baseUrl.replace(/\/$/, '');
    if (this.isAzureUrl(base)) {
      return this.azureModels(base, apiKey, signal);
    }
    const url = `${base}/models`;
    validateUrl(url);
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`${baseUrl} returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async azureModels(base: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
    const url = `${base}/openai/models?api-version=2024-02-01`;
    validateUrl(url);
    const res = await this.fetchFn(url, {
      headers: { 'api-key': apiKey },
      signal,
    });
    if (!res.ok) throw new Error(`Azure returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async ollamaModels(baseUrl: string, signal: AbortSignal): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    validateUrl(url, { allowLocalhost: true });
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Completion test
  // ---------------------------------------------------------------------------

  private async testCompletion(input: ValidateProviderInput, model: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
      switch (input.provider) {
        case 'ollama':
        case 'codex':
          return;
        case 'anthropic':
          await this.anthropicCompletion(input.apiKey, model, controller.signal);
          return;
        default:
          await this.openAiCompletion(
            this.resolveBaseUrl(input),
            input.apiKey,
            model,
            controller.signal,
          );
          return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveBaseUrl(input: ValidateProviderInput): string {
    switch (input.provider) {
      case 'openrouter':
        return input.baseUrl ?? 'https://openrouter.ai/api/v1';
      case 'openai':
        return input.baseUrl ?? 'https://api.openai.com/v1';
      case 'xai':
        // Pinned — see the `xai` case in `fetchModels`.
        return XAI_BASE_URL;
      case 'openai-compat':
      case 'azure':
      case 'codex':
        return input.baseUrl ?? '';
      default:
        return input.baseUrl ?? '';
    }
  }

  private async anthropicCompletion(
    apiKey: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal,
    });
    if (!res.ok) {
      throw await this.translateCompletionError(res, 'anthropic');
    }
  }

  private async openAiCompletion(
    baseUrl: string,
    apiKey: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const base = baseUrl.replace(/\/$/, '');
    let url: string;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (this.isAzureUrl(base)) {
      url = `${base}/openai/deployments/${model}/chat/completions?api-version=2024-08-01-preview`;
      headers['api-key'] = apiKey;
    } else {
      url = `${base}/chat/completions`;
      headers.authorization = `Bearer ${apiKey}`;
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal,
    });
    if (!res.ok) {
      throw await this.translateCompletionError(res, baseUrl);
    }
  }

  private async translateCompletionError(res: Response, provider: string): Promise<Error> {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    const lower = bodyText.toLowerCase();

    if (
      res.status === 402 ||
      lower.includes('insufficient_quota') ||
      lower.includes('billing') ||
      lower.includes('credit')
    ) {
      return new Error(
        "Your API key is valid but your account has no credits. Add credits at your provider's billing page.",
      );
    }

    if (
      res.status === 403 ||
      lower.includes('model_not_found') ||
      lower.includes('access_denied')
    ) {
      return new Error(
        'This model is not available on your plan. Try selecting a different model.',
      );
    }

    return new Error(
      `API key validated, but a test message failed: ${provider} returned ${res.status}. You may still proceed, but the agent may not respond.`,
    );
  }
}
