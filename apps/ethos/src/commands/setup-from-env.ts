// `ethos setup --from-env` (W2.4) — headless, non-interactive bootstrap for
// Docker / CI. Reads the same env vars the compose init script reads, validates
// the provider + Telegram tokens with the shared validators, and writes
// config/secrets through the existing writeConfig / SecretsResolver path
// (Storage abstraction — never raw node:fs).
//
// Idempotency contract (two restart classes):
//   (a) config.yaml is written ONCE (skip-if-exists) — a persisted volume keeps
//       user edits across restarts.
//   (b) secrets are re-synced from env on EVERY boot — env is authoritative in
//       Docker, so a rotated token in .env applies on restart. Only values that
//       CHANGED since last boot are re-validated.
//
// Liveness split (W1.2): a DEFINITIVE rejection (401/403) aborts with a non-zero
// exit; an unreachable endpoint (timeout/DNS/5xx/429) proceeds with a warning.
// `ETHOS_SKIP_VALIDATION=1` is the air-gapped escape hatch (no probes at all).
//
// Scope (resolved open-question 5): provider + Telegram first. The full channel
// matrix is a named follow-up.

import { type EthosConfig, readRawConfig, writeConfig } from '@ethosagent/config';
import { probeProvider } from '@ethosagent/wiring';
import { getProvider } from '@ethosagent/wiring/provider-catalog';
import { redactErrorMessage } from '../redact-error';
import { getFunnelTracker, getSecretsResolver, getStorage } from '../wiring';
import { scaffoldEthosDir } from './setup';

// ── Init last-line contract (W1.3 / Z-T14) ──────────────────────────────────
// Compose output is noisy; the FINAL line is the only line a first-run user
// reliably reads. These are the load-bearing strings the F3 exit criteria
// assert verbatim — keep them as the single source of truth so they can't
// drift. DESIGN.md voice: concrete cause + next action, ✓ glyph, mono
// identifiers, no exclamation marks.

/** Success — the FINAL stdout line the init service prints. */
export const INIT_SUCCESS_LINE = '✓ Config validated — web UI: http://localhost:3000';

/** Failure — the FINAL stderr line before a non-zero exit, per provider. */
export function providerRejectedLine(envVar: string): string {
  return `${envVar} rejected (401) — check the key in .env and re-run docker compose up`;
}

interface ResolvedProviderEnv {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  /** The env var the key came from — named in error/validation messages. */
  envVar: string;
}

/** Default chat model per provider — no env var carries it for most providers. */
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  openrouter: 'openai/gpt-4o',
  azure: 'gpt-4o',
  gemini: 'gemini-1.5-flash',
};

/** Provider precedence matches the compose init script it replaces. */
export function resolveProviderFromEnv(env: NodeJS.ProcessEnv): ResolvedProviderEnv | null {
  if (env.AZURE_API_KEY) {
    return {
      provider: 'azure',
      apiKey: env.AZURE_API_KEY,
      model: env.AZURE_MODEL || DEFAULT_MODEL.azure,
      baseUrl: env.AZURE_ENDPOINT,
      apiVersion: env.AZURE_API_VERSION || '2024-12-01-preview',
      envVar: 'AZURE_API_KEY',
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY,
      model: DEFAULT_MODEL.anthropic,
      envVar: 'ANTHROPIC_API_KEY',
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      model: DEFAULT_MODEL.openai,
      envVar: 'OPENAI_API_KEY',
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || DEFAULT_MODEL.openrouter,
      baseUrl: getProvider('openrouter')?.defaultBaseUrl,
      envVar: 'OPENROUTER_API_KEY',
    };
  }
  if (env.GOOGLE_API_KEY) {
    return {
      provider: 'gemini',
      apiKey: env.GOOGLE_API_KEY,
      model: DEFAULT_MODEL.gemini,
      baseUrl: getProvider('gemini')?.defaultBaseUrl,
      envVar: 'GOOGLE_API_KEY',
    };
  }
  return null;
}

function fail(message: string): never {
  // The actionable error is the FINAL line before non-zero exit so compose
  // surfaces it above the boot noise.
  console.error(message);
  process.exit(1);
}

export async function runSetupFromEnv(): Promise<void> {
  const env = process.env;
  const skipValidation = env.ETHOS_SKIP_VALIDATION === '1';
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  const existingConfig = await readRawConfig(storage);

  const prov = resolveProviderFromEnv(env);
  if (!prov) {
    fail(
      'No provider API key found — set one of: AZURE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY in .env and re-run docker compose up.',
    );
  }

  if (prov.provider === 'azure' && !prov.baseUrl) {
    fail('AZURE_ENDPOINT is required for Azure — set it in .env and re-run docker compose up.');
  }

  // ── provider secret: re-sync from env, validate only when the value changed ──
  const providerRef = `providers/${prov.provider}/apiKey`;
  const priorKey = await secrets.get(providerRef);
  if (!skipValidation && priorKey !== prov.apiKey) {
    console.log(`Validating ${prov.envVar}…`);
    const outcome = await probeProvider({
      provider: prov.provider,
      model: prov.model,
      apiKey: prov.apiKey,
      baseUrl: prov.baseUrl,
      apiVersion: prov.apiVersion,
    });
    if (!outcome.ok && outcome.reason === 'rejected') {
      fail(providerRejectedLine(prov.envVar));
    }
    if (!outcome.ok) {
      // Redact: the SDK error can echo the key (Gemini `?key=`, openai-compat
      // base URL) right into docker compose logs.
      console.warn(
        `WARNING: could not reach ${prov.provider} — key unverified, proceeding (${redactErrorMessage(
          outcome.error,
          prov.apiKey,
        )}).`,
      );
    }
  }
  await secrets.set(providerRef, prov.apiKey);

  // ── Telegram secret: re-sync from env, validate only when the value changed ──
  const telegramToken = env.TELEGRAM_BOT_TOKEN;
  const telegramConfigured = Boolean(telegramToken);
  if (telegramToken) {
    const tgRef = 'telegram/token';
    const priorTg = await secrets.get(tgRef);
    if (!skipValidation && priorTg !== telegramToken) {
      const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
      const v = await validateTelegramToken(telegramToken);
      if (!v.ok && v.reason === 'rejected') {
        fail(
          'TELEGRAM_BOT_TOKEN rejected by Telegram (401) — fix .env and re-run docker compose up.',
        );
      }
      if (!v.ok) {
        console.warn(
          `WARNING: could not reach Telegram — token unverified, proceeding (${redactErrorMessage(
            v.error ?? '',
            telegramToken,
          )}).`,
        );
      }
    }
    await secrets.set(tgRef, telegramToken);
  }

  // ── config.yaml: written ONCE (skip-if-exists) ──
  if (existingConfig) {
    console.log('config.yaml already exists — secrets re-synced from env, config preserved.');
  } else {
    const ownerId = env.TELEGRAM_OWNER_ID;
    const config: EthosConfig = {
      provider: prov.provider,
      model: prov.model,
      apiKey: `\${secrets:${providerRef}}`,
      personality: env.ETHOS_PERSONALITY || 'researcher',
      baseUrl: prov.baseUrl,
      apiVersion: prov.apiVersion,
      telegramToken: telegramConfigured ? `\${secrets:telegram/token}` : undefined,
      channelFilter:
        telegramConfigured && ownerId ? { telegram: { ownerUserId: ownerId } } : undefined,
    };
    await writeConfig(storage, config, secrets);
    await scaffoldEthosDir(storage);
  }

  // W4.1 — funnel.setup_completed fires here (wizard path: env). Best-effort.
  try {
    await getFunnelTracker().recordSetupCompleted({
      provider: prov.provider,
      channels: telegramConfigured ? ['telegram'] : [],
      wizardPath: 'env',
    });
  } catch {
    // Funnel instrumentation must never fail setup.
  }

  // Success — the FINAL line (init last-line contract, W1.3).
  console.log(INIT_SUCCESS_LINE);
}
