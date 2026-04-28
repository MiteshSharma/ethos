import { EthosError } from '@ethosagent/types';
import type { OnboardingStep, ProviderId } from '@ethosagent/web-contracts';
import type { ConfigRepository } from '../repositories/config.repository';
import type { PersonalityRepository } from '../repositories/personality.repository';

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
}

export interface CompleteInput {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  personalityId: string;
}

export interface OnboardingServiceOptions {
  config: ConfigRepository;
  personalities: PersonalityRepository;
  /** Inject for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

const VALIDATE_TIMEOUT_MS = 8_000;

export class OnboardingService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OnboardingServiceOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async state(): Promise<OnboardingState> {
    const raw = await this.opts.config.read();
    const hasProvider = !!(raw?.provider && raw.apiKey);
    const personalityId = raw?.personality ?? null;

    if (!raw) return { step: 'welcome', hasProvider: false, selectedPersonalityId: null };
    if (!hasProvider) return { step: 'provider', hasProvider: false, selectedPersonalityId: null };
    if (!personalityId) return { step: 'personality', hasProvider, selectedPersonalityId: null };
    // Provider + personality both set → done. Front-end may still show the
    // "first turn" magic moment but that's a UI concern, not a config gate.
    return { step: 'done', hasProvider, selectedPersonalityId: personalityId };
  }

  async validateProvider(input: ValidateProviderInput): Promise<ValidateProviderResult> {
    try {
      const models = await this.fetchModels(input);
      return { ok: true, models, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, models: null, error: message };
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
      apiKey: input.apiKey,
      personality: input.personalityId,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Provider model-list fetchers
  // ---------------------------------------------------------------------------

  private async fetchModels(input: ValidateProviderInput): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
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
        case 'openai-compat':
          if (!input.baseUrl) throw new Error('baseUrl required for openai-compat');
          return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
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

  private async openAiCompatibleModels(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`${baseUrl} returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async ollamaModels(baseUrl: string, signal: AbortSignal): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  }
}
