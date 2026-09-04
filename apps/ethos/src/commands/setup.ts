import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type EthosConfig,
  ethosDir,
  readRawConfig,
  writeConfig,
  writeKeys,
} from '@ethosagent/config';
import type { WizardStepId } from '@ethosagent/tui/setup';
import { probeProvider } from '@ethosagent/wiring';
import {
  detectLocalRuntime,
  fetchLocalModels,
  probeServedWindowCached,
  windowProbeCachePath,
} from '@ethosagent/wiring/local-models';
import { getProvider, PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { redactErrorMessage } from '../redact-error';
import { getFunnelTracker, getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Lane 5 — the setup hint derives from the provider catalog (non-comingSoon
 *  entries) so it can never drift from what wiring actually supports.
 *  Exported for the drift test. */
export function supportedProvidersHint(): string {
  return PROVIDER_CATALOG.filter((p) => !p.comingSoon)
    .map((p) => p.id)
    .join(', ');
}

/** D9 — the readline wizard's base-URL default for non-local, non-Azure
 *  providers. Returns the catalog `defaultBaseUrl` when the provider carries
 *  one; otherwise the historical OpenRouter literal, unchanged. Exported for
 *  the regression test that pins both halves. */
export function resolveWizardBaseUrl(provider: string): string {
  return getProvider(provider)?.defaultBaseUrl ?? 'https://openrouter.ai/api/v1';
}

export interface SetupResult {
  config: EthosConfig;
  /** W2.5 three-way close outcome from the TUI LaunchStep. The readline
   *  fallback has no launch step, so it always returns 'done'. */
  launch: 'gateway' | 'chat' | 'done';
  /** Validated Telegram `@username`, reused in the gateway success block. */
  telegramUsername?: string;
}

/** Providers that run against a local OpenAI-compatible endpoint: default the
 *  base URL to localhost, skip the API-key prompt, and offer the served model
 *  list from `GET /v1/models`. */
const LOCAL_PROVIDERS = new Set(['ollama', 'vllm']);

/** Placeholder API key written for local endpoints, which ignore it. */
const LOCAL_API_KEY = 'local';

export async function runSetup(startAtStep?: WizardStepId): Promise<SetupResult | null> {
  const storage = getStorage();
  const existingConfig = await readRawConfig(storage);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runSetupWizard } = await import('@ethosagent/tui/setup');

    const existingAnswers = existingConfig
      ? {
          provider: existingConfig.provider,
          model: existingConfig.model,
          apiKey: existingConfig.apiKey,
          baseUrl: existingConfig.baseUrl,
          apiVersion: existingConfig.apiVersion,
          personality: existingConfig.personality,
          memory: existingConfig.memory,
          telegramToken: existingConfig.telegramToken,
          discordToken: existingConfig.discordToken,
          slackBotToken: existingConfig.slackBotToken,
          slackAppToken: existingConfig.slackAppToken,
          slackSigningSecret: existingConfig.slackSigningSecret,
          emailImapHost: existingConfig.emailImapHost,
          emailImapPort: existingConfig.emailImapPort,
          emailUser: existingConfig.emailUser,
          emailPassword: existingConfig.emailPassword,
          emailSmtpHost: existingConfig.emailSmtpHost,
          emailSmtpPort: existingConfig.emailSmtpPort,
          providers: existingConfig.providers,
        }
      : null;

    const result = await runSetupWizard({
      existing: existingAnswers,
      startAtStep,
      singleStep: !!startAtStep,
    });
    if (!result) return null;

    const { answers } = result;
    const secrets = await getSecretsResolver();
    const provider = answers.provider ?? 'anthropic';

    let apiKeyRef = '';
    if (answers.apiKey) {
      const ref = `providers/${provider}/apiKey`;
      await secrets.set(ref, answers.apiKey);
      apiKeyRef = `\${secrets:${ref}}`;
    }

    const config: EthosConfig = {
      provider,
      model: answers.model ?? 'claude-opus-4-7',
      apiKey: apiKeyRef,
      personality: answers.personality ?? 'researcher',
      memory: answers.memory,
      baseUrl: answers.baseUrl,
      apiVersion: answers.apiVersion,
      providers: answers.providers
        ? await storeProviderSecrets(answers.providers, secrets)
        : undefined,
      telegramToken: answers.telegramToken
        ? await storeSecret(secrets, 'telegram/token', answers.telegramToken)
        : undefined,
      discordToken: answers.discordToken
        ? await storeSecret(secrets, 'discord/token', answers.discordToken)
        : undefined,
      slackBotToken: answers.slackBotToken
        ? await storeSecret(secrets, 'slack/botToken', answers.slackBotToken)
        : undefined,
      slackAppToken: answers.slackAppToken
        ? await storeSecret(secrets, 'slack/appToken', answers.slackAppToken)
        : undefined,
      slackSigningSecret: answers.slackSigningSecret
        ? await storeSecret(secrets, 'slack/signingSecret', answers.slackSigningSecret)
        : undefined,
      emailImapHost: answers.emailImapHost,
      emailImapPort: answers.emailImapPort,
      emailUser: answers.emailUser,
      emailPassword: answers.emailPassword
        ? await storeSecret(secrets, 'email/password', answers.emailPassword)
        : undefined,
      emailSmtpHost: answers.emailSmtpHost,
      emailSmtpPort: answers.emailSmtpPort,
    };

    await writeConfig(storage, config, secrets);
    await scaffoldEthosDir(storage);

    if (answers.rotationKeys && answers.rotationKeys.length > 0) {
      await writeKeys(storage, answers.rotationKeys, secrets);
    }

    await recordSetupFunnel(config, 'tui');

    return { config, launch: result.launch, telegramUsername: answers.telegramUsername };
  }

  const config = await runReadlineFallback({ storage, existing: existingConfig });
  if (config) await recordSetupFunnel(config, 'readline');
  return config ? { config, launch: 'done' } : null;
}

/** W4.1 — funnel.setup_completed fires at the end of runSetup. Best-effort. */
async function recordSetupFunnel(config: EthosConfig, wizardPath: 'tui' | 'readline') {
  try {
    await getFunnelTracker().recordSetupCompleted({
      provider: config.provider,
      channels: configuredChannels(config),
      wizardPath,
    });
  } catch {
    // Funnel instrumentation must never fail setup.
  }
}

function configuredChannels(config: EthosConfig): string[] {
  const channels: string[] = [];
  if (config.telegramToken) channels.push('telegram');
  if (config.discordToken) channels.push('discord');
  if (config.slackBotToken) channels.push('slack');
  if (config.emailImapHost && config.emailUser) channels.push('email');
  return channels;
}

export async function scaffoldEthosDir(storage: ReturnType<typeof getStorage>) {
  const dir = ethosDir();
  await storage.mkdir(join(dir, 'personalities'));
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
    }
  }
}

async function runReadlineFallback({
  storage,
  existing,
}: {
  storage: ReturnType<typeof getStorage>;
  existing: EthosConfig | null;
}): Promise<EthosConfig | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (existing) {
    const ans = await ask(
      rl,
      `${c.yellow}Config already exists at ~/.ethos/config.yaml. Overwrite? (y/N)${c.reset} `,
    );
    if (ans.trim().toLowerCase() !== 'y') {
      console.log(`${c.dim}Keeping existing config.${c.reset}`);
      rl.close();
      return existing;
    }
  }

  console.log(`\n${c.cyan}${c.bold}ethos setup${c.reset}\n`);

  console.log(`${c.dim}Supported providers: ${supportedProvidersHint()}${c.reset}`);
  const provider = (await ask(rl, 'Provider (anthropic): ')).trim() || 'anthropic';

  let model: string;
  let apiKey: string;
  let baseUrl: string | undefined;
  let apiVersion: string | undefined;

  if (LOCAL_PROVIDERS.has(provider)) {
    // Local OpenAI-compatible endpoint (Ollama / vLLM): localhost base URL,
    // no API-key prompt, model list offered from GET /v1/models when reachable.
    const defaultBaseUrl = getProvider(provider)?.defaultBaseUrl ?? 'http://localhost:11434/v1';
    baseUrl = (await ask(rl, `Base URL (${defaultBaseUrl}): `)).trim() || defaultBaseUrl;
    apiKey = LOCAL_API_KEY;

    console.log(`${c.dim}Checking ${baseUrl} for available models…${c.reset}`);
    const { reachable, models } = await fetchLocalModels(baseUrl);
    if (reachable) {
      console.log(`${c.dim}Available models:${c.reset}`);
      for (const [i, m] of models.entries()) {
        console.log(`  ${c.bold}${i + 1}${c.reset}. ${m}`);
      }
      const firstModel = models[0] ?? '';
      const choice = (
        await ask(rl, `Model (1-${models.length}, or name) [${firstModel}]: `)
      ).trim();
      const n = Number.parseInt(choice, 10);
      if (choice === '') {
        model = firstModel;
      } else if (Number.isInteger(n) && n >= 1 && n <= models.length) {
        model = models[n - 1] ?? firstModel;
      } else {
        model = choice;
      }
    } else {
      console.log(`${c.yellow}Endpoint not reachable — enter a model name manually.${c.reset}`);
      model = (await ask(rl, 'Model: ')).trim();
    }

    // Lane 0 (D16) — setup probes the SERVED context window live and warms
    // the probe cache. Fail-soft: an unreachable probe prints a diagnostic
    // and setup continues.
    const runtime = detectLocalRuntime(provider, baseUrl);
    if (runtime && model) {
      const probe = await probeServedWindowCached({
        runtime,
        baseUrl,
        model,
        storage: getStorage(),
        cachePath: windowProbeCachePath(ethosDir()),
        forceRefresh: true,
      });
      if (probe.contextWindow !== undefined) {
        console.log(
          `${c.dim}Served context window: ${probe.contextWindow.toLocaleString('en-US')} tokens${c.reset}`,
        );
      } else if (probe.diagnostic) {
        console.log(`${c.yellow}${probe.diagnostic}${c.reset}`);
      }
    }
  } else {
    const defaultModel =
      provider === 'anthropic'
        ? 'claude-opus-4-7'
        : provider === 'azure'
          ? 'gpt-5.4'
          : 'openai/gpt-4o';
    const modelPrompt =
      provider === 'azure'
        ? `Azure deployment name (${defaultModel}): `
        : `Model (${defaultModel}): `;
    model = (await ask(rl, modelPrompt)).trim() || defaultModel;

    apiKey = (await ask(rl, 'API key: ')).trim();
    if (!apiKey) {
      console.log(
        `${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
      );
    }

    if (provider === 'azure') {
      baseUrl = (
        await ask(rl, 'Azure endpoint (e.g. https://my-resource.openai.azure.com): ')
      ).trim();
      if (!baseUrl) {
        console.log(
          `${c.yellow}Warning: no Azure endpoint entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
        );
      }
      apiVersion = (await ask(rl, 'API version (2024-10-21): ')).trim() || undefined;
    } else if (provider !== 'anthropic') {
      // D9 — consult the catalog before falling back to the OpenRouter literal:
      // probeProvider live-validates the key against this URL before config is
      // written, so a non-OpenRouter key sent to openrouter.ai is rejected and
      // setup exits non-zero. PARTIAL BY CONSTRUCTION: `openai`, `anthropic`,
      // `codex`, `azure` and `bedrock` carry no `defaultBaseUrl`, so the literal
      // still applies to them. This is not a fix for every non-local provider.
      const defaultBaseUrl = resolveWizardBaseUrl(provider);
      baseUrl = (await ask(rl, `Base URL (${defaultBaseUrl}): `)).trim() || defaultBaseUrl;
    }
  }

  // W2.2 — validate the provider key with a live 1-token probe before writing
  // config. A DEFINITIVELY rejected key (401/403) never reaches disk: re-prompt
  // up to 3 times, then exit non-zero (non-TTY stdin can't loop forever). An
  // unreachable endpoint (timeout/DNS/5xx/429) warns and proceeds (W1.2).
  if (apiKey && !LOCAL_PROVIDERS.has(provider)) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      console.log(`${c.dim}Validating ${provider} key…${c.reset}`);
      const outcome = await probeProvider({ provider, model, apiKey, baseUrl, apiVersion });
      if (outcome.ok) {
        console.log(`${c.green}✓ API key validated${c.reset}`);
        break;
      }
      if (outcome.reason === 'unreachable') {
        console.log(
          `${c.yellow}⚠ Couldn't reach ${provider} — saved unverified.${c.reset} ${c.dim}(${redactErrorMessage(
            outcome.error,
            apiKey,
          )})${c.reset}`,
        );
        break;
      }
      if (attempt >= MAX_ATTEMPTS) {
        rl.close();
        console.error(
          'API key rejected after 3 attempts — get a key at console.anthropic.com and re-run ethos setup.',
        );
        process.exit(1);
      }
      console.log(
        `${c.yellow}✗ API key rejected (attempt ${attempt}/${MAX_ATTEMPTS}).${c.reset} ${c.dim}Re-enter it.${c.reset}`,
      );
      apiKey = (await ask(rl, 'API key: ')).trim();
    }
  }

  console.log(
    `\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`,
  );
  const personality = (await ask(rl, 'Default personality (researcher): ')).trim() || 'researcher';

  rl.close();

  const secrets = await getSecretsResolver();
  let apiKeyRef = '';
  if (apiKey) {
    const ref = `providers/${provider}/apiKey`;
    await secrets.set(ref, apiKey);
    apiKeyRef = `\${secrets:${ref}}`;
  }

  const config: EthosConfig = {
    provider,
    model,
    apiKey: apiKeyRef,
    personality,
    baseUrl,
    apiVersion,
  };
  await writeConfig(storage, config, secrets);
  await scaffoldEthosDir(storage);

  console.log(`\n${c.green}✓ Config saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(`${c.green}✓ ~/.ethos/ directory ready${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`,
  );

  return config;
}

async function storeSecret(
  secrets: import('@ethosagent/types').SecretsResolver,
  ref: string,
  value: string,
): Promise<string> {
  await secrets.set(ref, value);
  return `\${secrets:${ref}}`;
}

async function storeProviderSecrets(
  providers: Array<{ provider: string; apiKey: string; model?: string; baseUrl?: string }>,
  secrets: import('@ethosagent/types').SecretsResolver,
): Promise<Array<{ provider: string; apiKey: string; model?: string; baseUrl?: string }>> {
  return Promise.all(
    providers.map(async (p, i) => ({
      ...p,
      apiKey: p.apiKey
        ? await storeSecret(secrets, `providers/${i}/${p.provider}/apiKey`, p.apiKey)
        : '',
    })),
  );
}
