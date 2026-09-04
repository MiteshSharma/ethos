import { validateUrl } from '@ethosagent/core';
import { anthropicFactory } from '@ethosagent/llm-anthropic';
import { azureFactory } from '@ethosagent/llm-azure';
import { bedrockFactory } from '@ethosagent/llm-bedrock';
import { codexFactory } from '@ethosagent/llm-codex';
import { geminiNativeFactory } from '@ethosagent/llm-gemini-native';
import { OPENAI_COMPAT_ALIASES, openaiCompatFactory } from '@ethosagent/llm-openai-compat';
import { xaiFactory } from '@ethosagent/llm-xai';
import type {
  ConfigOnlyProviderManifest,
  LLMProviderFactory,
  LLMProviderRegistry,
} from '@ethosagent/types';
import { createConfigOnlyFactory } from './config-only-provider';
import { BUILTIN_CONFIG_PROVIDERS } from './provider-manifests';

// Re-export so existing importers (if any) still find it at this path.
export { AZURE_DEFAULT_API_VERSION } from '@ethosagent/llm-azure';

/**
 * Register ALL built-in LLM providers on the given registry.
 *
 * Used by the standalone `createLLM` helper (no plugin infrastructure).
 * The `buildInfrastructure` path uses `activateFirstPartyPlugins` +
 * `registerRemainingBuiltinProviders` instead.
 */
export function registerBuiltinProviders(registry: LLMProviderRegistry): void {
  // --- Migrated providers (factories imported from extensions) ---------------
  registry.register('anthropic', anthropicFactory);

  // Azure: wrap with SSRF gate
  const validatedAzure: LLMProviderFactory = async (ctx) => {
    if (ctx.config.baseUrl) {
      validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
    }
    return azureFactory(ctx);
  };
  registry.register('azure', validatedAzure);

  registry.register('codex', codexFactory);

  // OpenAI-compat: wrap with SSRF gate
  const validatedOpenaiCompat: LLMProviderFactory = async (ctx) => {
    if (ctx.config.baseUrl) {
      validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
    }
    return openaiCompatFactory(ctx);
  };
  registry.register('openai-compat', validatedOpenaiCompat);
  for (const id of OPENAI_COMPAT_ALIASES) {
    registry.register(id, validatedOpenaiCompat);
  }

  // --- Migrated providers without an activate-path in createLLM ----------
  registry.register('bedrock', bedrockFactory);

  // Gemini-native: wrap with SSRF gate (has configurable baseUrl)
  const validatedGeminiNative: LLMProviderFactory = async (ctx) => {
    if (ctx.config.baseUrl) {
      validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
    }
    return geminiNativeFactory(ctx);
  };
  registry.register('gemini-native', validatedGeminiNative);

  // xAI (Grok): no SSRF gate — the provider pins its own baseUrl and ignores
  // the config's, so there is no operator-supplied URL to validate. Registered
  // exactly once: `xai` is deliberately absent from OPENAI_COMPAT_ALIASES and
  // from BUILTIN_CONFIG_PROVIDERS, because the registry THROWS on a duplicate id
  // and both lists are iterated onto this same registry.
  registry.register('xai', xaiFactory);

  // Config-only providers from built-in manifests
  for (const manifest of BUILTIN_CONFIG_PROVIDERS) {
    registerConfigOnlyProvider(registry, manifest);
  }
}

/**
 * Register built-in providers NOT yet migrated to the plugin SDK.
 * Called by `buildInfrastructure` after `activateFirstPartyPlugins` handles
 * the four migrated providers (anthropic, openai-compat, azure, codex).
 */
export function registerRemainingBuiltinProviders(registry: LLMProviderRegistry): void {
  for (const manifest of BUILTIN_CONFIG_PROVIDERS) {
    registerConfigOnlyProvider(registry, manifest);
  }
}

export function registerConfigOnlyProvider(
  registry: LLMProviderRegistry,
  manifest: ConfigOnlyProviderManifest,
): void {
  registry.register(manifest.id, createConfigOnlyFactory(manifest));
}
