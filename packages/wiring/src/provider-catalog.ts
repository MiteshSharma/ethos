export interface ProviderCatalogEntry {
  id: string;
  label: string;
  description: string;
  authType: 'api-key' | 'self-hosted' | 'device-auth' | 'iam-role';
  costType: 'api-billing' | 'pay-per-use' | 'local';
  recommended?: boolean;
  comingSoon?: boolean;
  signupUrl?: string;
  defaultBaseUrl?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // Recommended
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude models — best for coding and analysis',
    authType: 'api-key',
    costType: 'api-billing',
    recommended: true,
    signupUrl: 'https://console.anthropic.com',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT and o-series models',
    authType: 'api-key',
    costType: 'api-billing',
    recommended: true,
    signupUrl: 'https://platform.openai.com',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    description: 'Codex models via OpenAI account — experimental, device code auth',
    authType: 'device-auth',
    costType: 'api-billing',
    signupUrl: 'https://openai.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '200+ models behind one key — try any provider',
    authType: 'api-key',
    costType: 'pay-per-use',
    recommended: true,
    signupUrl: 'https://openrouter.ai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    description: 'OpenAI models via your Azure resource — deployment name = model',
    authType: 'api-key',
    costType: 'api-billing',
    signupUrl: 'https://portal.azure.com',
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    description: 'Claude and other models via your AWS account — IAM role, SSO, or profile',
    authType: 'iam-role',
    costType: 'api-billing',
    signupUrl: 'https://console.aws.amazon.com/bedrock',
  },
  // Coming soon
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models via OpenAI-compatible API',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://aistudio.google.com',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast inference — LLaMA, Mixtral, and more',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://console.groq.com',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Competitive with Claude and GPT at lower cost',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://platform.deepseek.com',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'ollama',
    label: 'Local Models (Ollama)',
    description: 'Run models locally — no API key required',
    authType: 'self-hosted',
    costType: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
  },
  {
    id: 'vllm',
    label: 'Local Models (vLLM)',
    description: 'Run models locally via vLLM — no API key required',
    authType: 'self-hosted',
    costType: 'local',
    defaultBaseUrl: 'http://localhost:8000/v1',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    description: 'Mistral models via OpenAI-compatible API',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://console.mistral.ai',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'together',
    label: 'Together AI',
    description: 'Open-source models on fast hosted inference',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://api.together.ai',
    defaultBaseUrl: 'https://api.together.xyz/v1',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    description: 'Fast hosted inference for Llama, Qwen, DeepSeek, and more',
    authType: 'api-key',
    costType: 'api-billing',
    comingSoon: true,
    signupUrl: 'https://fireworks.ai',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  },
];

export function getProvider(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
