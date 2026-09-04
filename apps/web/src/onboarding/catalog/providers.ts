export type CatalogProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'openai-compat'
  | 'ollama'
  | 'codex'
  | 'xai';

export interface ProviderCatalogEntry {
  id: CatalogProviderId;
  label: string;
  description: string;
  authType: 'api-key' | 'self-hosted' | 'device-auth';
  recommended?: boolean;
  signupUrl?: string;
  baseUrl?: {
    default?: string;
    required?: boolean;
    keyless?: boolean;
  };
  /** The ProviderId we wire through to the server */
  wiresAs: 'anthropic' | 'openrouter' | 'openai-compat' | 'ollama' | 'codex' | 'xai';
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Direct Claude API. Best with the latest Claude models.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://console.anthropic.com',
    wiresAs: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-5 / GPT-4 family via api.openai.com.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://platform.openai.com/api-keys',
    baseUrl: { default: 'https://api.openai.com/v1' },
    wiresAs: 'openai-compat',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '200+ models behind one key.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://openrouter.ai/keys',
    baseUrl: { default: 'https://openrouter.ai/api/v1' },
    wiresAs: 'openrouter',
  },
  {
    id: 'xai',
    // Deliberate: Grok is premium and paid with no free tier, so `recommended`
    // stays falsy and it renders behind "Show all providers" — same call
    // already recorded in packages/wiring/src/provider-catalog.ts. No `baseUrl`
    // block: the provider pins https://api.x.ai/v1 and ignores any configured
    // value, so prompting for a URL would offer a choice that does nothing.
    label: 'xAI Grok',
    description: 'Grok models direct from xAI — paid API, no free tier.',
    authType: 'api-key',
    signupUrl: 'https://console.x.ai/',
    wiresAs: 'xai',
  },
  {
    id: 'openai-compat',
    label: 'OpenAI-compatible',
    description: 'Any provider that speaks the OpenAI API (Groq, Together, vLLM…).',
    authType: 'api-key',
    baseUrl: { required: true },
    wiresAs: 'openai-compat',
  },
  {
    id: 'ollama',
    label: 'Local Models (Ollama)',
    description: 'No key required — defaults to http://localhost:11434.',
    authType: 'self-hosted',
    baseUrl: { default: 'http://localhost:11434', keyless: true },
    wiresAs: 'ollama',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    description: 'Codex models via your ChatGPT account — device code auth, no API key needed.',
    authType: 'device-auth',
    wiresAs: 'codex',
  },
];

export const API_KEY_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.authType === 'api-key');
export const SELF_HOSTED_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.authType === 'self-hosted');
export const DEVICE_AUTH_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.authType === 'device-auth');
export const RECOMMENDED_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.recommended);
export const EXPANDED_PROVIDERS = PROVIDER_CATALOG.filter(
  (p) => !p.recommended && p.authType === 'api-key',
);

export function getCatalogEntry(id: CatalogProviderId): ProviderCatalogEntry {
  const found = PROVIDER_CATALOG.find((p) => p.id === id);
  if (found) return found;
  return (
    PROVIDER_CATALOG[0] ?? {
      id: 'anthropic',
      label: 'Anthropic Claude',
      description: '',
      authType: 'api-key',
      wiresAs: 'anthropic',
    }
  );
}
