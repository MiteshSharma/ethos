import { EthosError, isValidSecretName, type SecretsResolver } from '@ethosagent/types';
import {
  NAMED_SECRET_PROVIDER_KINDS,
  type NamedSecretKind,
  type NamedSecretProvider,
} from '@ethosagent/web-contracts';

// Global named-secrets vault manager (Phase 2, web-search-provider-selection).
//
// A named secret is stored at `providers/<provider>/<name>` in the secrets
// vault — the same namespace a consuming tool's capability prefix grant
// (`providers/{exa,tavily,brave}/*` for `web_search`, `providers/xai/*` for
// `x_search`) allows. A personality only ever stores the secret NAME (a
// reference); the VALUE lives here and NEVER round-trips back to the client —
// reads are masked previews only.
//
// Everything is provider-scoped: a provider maps to exactly one `kind`, which
// is what a tool's `secret-binding` field filters the picker by.

export type { NamedSecretProvider } from '@ethosagent/web-contracts';

export interface NamedSecretProviderEntry {
  provider: NamedSecretProvider;
  kind: NamedSecretKind;
  label: string;
  /** Where the operator goes to obtain this credential. */
  getKeyUrl: string;
}

/** Every provider namespace a named secret may live under. `kind` comes from
 *  the contract's `NAMED_SECRET_PROVIDER_KINDS` so the picker and the vault
 *  can never disagree about which kind a provider is. */
export const NAMED_SECRET_PROVIDERS: readonly NamedSecretProviderEntry[] = (
  [
    { provider: 'exa', label: 'Exa', getKeyUrl: 'https://exa.ai/' },
    { provider: 'tavily', label: 'Tavily', getKeyUrl: 'https://tavily.com/' },
    { provider: 'brave', label: 'Brave Search', getKeyUrl: 'https://brave.com/search/api/' },
    { provider: 'xai', label: 'xAI (Grok, X search)', getKeyUrl: 'https://console.x.ai/' },
    {
      provider: 'x',
      label: 'X API (bearer token)',
      getKeyUrl: 'https://developer.x.com/en/portal/dashboard',
    },
  ] satisfies Omit<NamedSecretProviderEntry, 'kind'>[]
).map((e) => ({ ...e, kind: NAMED_SECRET_PROVIDER_KINDS[e.provider] }));

/** Upper bound on a stored secret value. Real provider API keys are well under
 *  1 KiB; the cap is a DoS guard so a client cannot fill the vault dir. */
const MAX_VALUE_BYTES = 8 * 1024;

export interface NamedSecretView {
  provider: NamedSecretProvider;
  name: string;
  /** Masked preview — e.g. `sk-…abc1`. Never the raw value. */
  preview: string;
  /** Category the SecretPicker filters by — see `NAMED_SECRET_PROVIDER_KINDS`. */
  kind: NamedSecretKind;
}

export interface NamedSecretsServiceOptions {
  secrets: SecretsResolver;
}

export class NamedSecretsService {
  constructor(private readonly opts: NamedSecretsServiceOptions) {}

  /** List every named secret across all provider namespaces, with MASKED
   *  previews only. The raw value never crosses this boundary. */
  async list(): Promise<{ secrets: NamedSecretView[] }> {
    const out: NamedSecretView[] = [];
    for (const { provider, kind } of NAMED_SECRET_PROVIDERS) {
      const prefix = `providers/${provider}/`;
      const refs = await this.opts.secrets.list(prefix);
      for (const ref of refs) {
        const name = ref.slice(prefix.length);
        // Only flat `<name>` entries — no nested paths under a provider.
        if (!name || name.includes('/')) continue;
        const value = await this.opts.secrets.get(ref);
        out.push({ provider, name, preview: redactSecret(value), kind });
      }
    }
    out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    return { secrets: out };
  }

  /** Create / overwrite a named secret. The raw value is written to the vault
   *  and is NOT echoed back — the caller receives only a masked preview. */
  async create(input: {
    provider: string;
    name: string;
    value: string;
  }): Promise<{ ok: true; preview: string }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    if (input.value.length === 0) {
      throw invalid('Secret value must not be empty.', 'Enter the API key value.');
    }
    if (Buffer.byteLength(input.value, 'utf8') > MAX_VALUE_BYTES) {
      throw invalid('Secret value is too large.', 'API keys are short — paste only the key.');
    }
    await this.opts.secrets.set(`providers/${provider}/${name}`, input.value);
    return { ok: true, preview: redactSecret(input.value) };
  }

  /** Delete a named secret. Idempotent — a missing secret is already gone. */
  async delete(input: { provider: string; name: string }): Promise<{ ok: true }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    await this.opts.secrets.delete(`providers/${provider}/${name}`);
    return { ok: true };
  }

  /** Optional probe — resolves the stored value and makes one lightweight
   *  authenticated request to the provider so the user can confirm the key
   *  works. The raw key travels provider-ward only, never back to the client.
   *  A provider with no free probe (`x` — every search call is billable) is
   *  reported as `tested: false`: the secret exists, its validity is unknown. */
  async testKey(input: {
    provider: string;
    name: string;
  }): Promise<{ ok: boolean; error?: string; tested?: boolean }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    const value = await this.opts.secrets.get(`providers/${provider}/${name}`);
    if (!value) return { ok: false, error: 'Secret not found.' };
    if (provider === 'x') return { ok: true, tested: false };
    try {
      return await probeProvider(provider, value);
    } catch (err) {
      // This path handled the raw API key in fetch headers — never echo the
      // caught error verbatim (it can carry the URL, headers, or key). Collapse
      // to a fixed category the client can render safely.
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? 'Key check timed out.' : 'Key check could not be completed.',
      };
    }
  }

  private assertProvider(provider: string): NamedSecretProvider {
    const entry = NAMED_SECRET_PROVIDERS.find((p) => p.provider === provider);
    if (entry) return entry.provider;
    throw invalid(
      `Unknown provider "${provider}".`,
      `Use one of: ${NAMED_SECRET_PROVIDERS.map((p) => p.provider).join(', ')}.`,
    );
  }

  private assertName(name: string): string {
    if (!isValidSecretName(name)) {
      throw invalid(
        `Invalid secret name "${name}".`,
        'Use letters, digits, hyphens, and underscores only.',
      );
    }
    return name;
  }
}

/**
 * Mask a secret value for display:
 *   • `sk-…abc1` — first 3 + last 4 (10+ chars)
 *   • `<set>`    — present but shorter than 10 (too short to preview without
 *                 over-exposing a real key — e.g. a 6-char key showing 4 chars)
 *   • `<unset>`  — absent/empty
 */
export function redactSecret(value: string | null | undefined): string {
  if (!value) return '<unset>';
  if (value.length >= 10) return `${value.slice(0, 3)}…${value.slice(-4)}`;
  return '<set>';
}

// ---------------------------------------------------------------------------
// Per-provider key probes. Each makes a single minimal authenticated request
// and treats a 2xx (or a non-auth error) as "the key is accepted".
// ---------------------------------------------------------------------------

async function probeProvider(
  provider: Exclude<NamedSecretProvider, 'x'>,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    if (provider === 'xai') {
      const res = await fetch('https://api.x.ai/v1/models', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      return interpret(res.status);
    }
    if (provider === 'exa') {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query: 'ethos key check', numResults: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    }
    if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key, query: 'ethos key check', max_results: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    }
    // brave
    const res = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=ethos%20key%20check&count=1',
      {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: controller.signal,
      },
    );
    return interpret(res.status);
  } finally {
    clearTimeout(timeout);
  }
}

function interpret(status: number): { ok: boolean; error?: string } {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, error: 'Key rejected (unauthorized).' };
  if (status === 429) return { ok: true }; // rate-limited but authenticated
  return { ok: false, error: `Provider returned HTTP ${status}.` };
}

function invalid(cause: string, action: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action });
}
