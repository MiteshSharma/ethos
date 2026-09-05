import type { LLMProvider, SecretRef, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  ALL_BACKENDS,
  createSearxngBackend,
  type KeylessSearchBackend,
  type SearchBackend,
} from './search-backends';
import { checkSsrf } from './ssrf';
import { summarizeBySize } from './summarize';

// ---------------------------------------------------------------------------
// HTML → plain text (no external dep)
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// web_search — dispatches across Exa / Tavily / Brave backends
// ---------------------------------------------------------------------------

/**
 * A resolved per-personality web_search binding: which provider, and which
 * named secret. `secret` is a NAME only (e.g. `exa-main`) — never a value —
 * that resolves to `providers/<provider>/<name>` in the vault. Absent `secret`
 * falls back to the provider's default-named secret (`providers/<id>/apiKey`).
 */
export interface WebSearchSetting {
  provider?: 'exa' | 'tavily' | 'brave';
  secret?: string;
}

interface WebSearchSelectionOptions {
  searchBackend?: 'exa' | 'tavily' | 'brave';
  /**
   * `web.searxng.url`. An extra, keyless RUNG rather than a bindable provider:
   * `web.search_backend` and the personality `tools.yaml` binding are both
   * typed to the three keyed providers, so SearXNG is reached by having no
   * keyed backend available — which is exactly what "an optional extra rung"
   * means in the config contract.
   */
  searxngUrl?: string;
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => WebSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { web_search?: WebSearchSetting } | undefined>;
}

type Selected =
  | { backend: SearchBackend; secretRef: SecretRef }
  | { searxng: KeylessSearchBackend };

function makeWebSearchTool(opts: WebSearchSelectionOptions = {}): Tool {
  const { searchBackend, resolvePersonalitySetting, toolSettings } = opts;
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  // 5-step resolution: personality tools.yaml → global toolSettings[pid] →
  // global toolSettings._default → first backend with a key present → the
  // keyless SearXNG rung, when one is configured.
  function selectBackend(ctx: ToolContext): Selected | null {
    const pid = ctx.personalityId;
    const setting =
      (pid ? resolvePersonalitySetting?.(pid) : undefined) ??
      (pid ? toolSettings?.[pid]?.web_search : undefined) ??
      toolSettings?._default?.web_search;

    if (setting?.provider) {
      const backend = ALL_BACKENDS.find((b) => b.id === setting.provider);
      if (backend) {
        const name = setting.secret?.trim();
        const secretRef = name ? `providers/${backend.id}/${name}` : backend.secretRef;
        return { backend, secretRef };
      }
    }

    // Backward compat: construction-time preference, then first-available.
    if (searchBackend) {
      const pref = ALL_BACKENDS.find((b) => b.id === searchBackend);
      if (pref?.isAvailable()) return { backend: pref, secretRef: pref.secretRef };
    }
    const first = ALL_BACKENDS.find((b) => b.isAvailable());
    if (first) return { backend: first, secretRef: first.secretRef };
    return searxng ? { searxng } : null;
  }

  return {
    name: 'web_search',
    description:
      'Search the web for current information. Returns titles, URLs, and text snippets. Requires one of EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY, or a configured SearXNG instance.',
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      // The SearXNG host is operator-configured, so it joins the allowlist at
      // construction — the tool still cannot reach anything else.
      network: {
        allowedHosts: [
          'api.exa.ai',
          'api.tavily.com',
          'api.search.brave.com',
          ...(searxng ? [searxng.host] : []),
        ],
      },
      // Prefix grant over web_search's own provider namespaces. Any
      // personality binding is `providers/<provider>/<name>`, so it always
      // falls inside this static allowlist — no per-binding runtime grant.
      // Refs outside these namespaces (LLM keys, channel tokens) stay denied.
      secrets: ['providers/exa/*', 'providers/tavily/*', 'providers/brave/*'],
    },
    outputIsUntrusted: true,
    // Phase 2 — per-personality config contract. The web personality-settings
    // UI renders this into a provider dropdown + a secret picker; the resulting
    // binding is written to the personality's tools.yaml (custom) or the global
    // toolSettings fallback (built-in). Only the secret NAME is ever stored.
    settingsSchema: {
      fields: [
        {
          kind: 'enum',
          key: 'provider',
          label: 'Provider',
          options: [
            { value: 'exa', label: 'Exa' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'brave', label: 'Brave' },
          ],
        },
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'API key',
          secretKind: 'web-search',
        },
      ],
    },
    // web_search is always registered. A key can arrive from an env var OR from
    // the named-secrets vault via a personality/global binding — and the vault
    // is not reachable at filter time (isAvailable has no ToolContext/resolver).
    // Gating solely on env vars would filter the tool out for a user who
    // onboarded purely through Settings > Named Secrets. Instead the tool stays
    // available and `execute` surfaces a clear "no key configured" error when no
    // backend can resolve one.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10)',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { query, num_results } = args as { query: string; num_results?: number };

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      const selected = selectBackend(ctx);
      if (!selected) {
        return {
          ok: false,
          error:
            'No web search provider is configured. Add a key in Settings > Named Secrets and bind it to a provider in the personality tool settings, or set EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.',
          code: 'not_available' as const,
        };
      }
      const numResults = Math.min(num_results ?? 5, 10);

      try {
        const providerId = 'searxng' in selected ? selected.searxng.id : selected.backend.id;
        const hits =
          'searxng' in selected
            ? await selected.searxng.search(query, numResults, ctx)
            : await selected.backend.search(query, numResults, ctx, selected.secretRef);

        if (!hits.length) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const formatted = hits
          .map((r, i) => {
            const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
            const snippet = r.text?.trim().slice(0, 400) ?? '';
            return `${i + 1}. **${r.title ?? 'Untitled'}**${date}\n   ${r.url}\n   ${snippet}`;
          })
          .join('\n\n');

        return {
          ok: true,
          value: `Search results for "${query}" (via ${providerId}):\n\n${formatted}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// web_extract — fetch page content; size-tiered aux-model summarization
// ---------------------------------------------------------------------------

function makeWebExtractTool(
  buildSummarize?: (ctx: ToolContext) => ((chunk: string) => Promise<string>) | null,
): Tool {
  return {
    name: 'web_extract',
    description:
      'Fetch a URL and extract its text content. Use to read articles, documentation, or any web page.',
    toolset: 'web',
    maxResultChars: 20_000,
    capabilities: {
      // Tool fetches arbitrary user-supplied URLs; SSRF protection is enforced
      // by ScopedFetch → safeFetch, not by this allowlist. The personality-level
      // network policy provides the outer gate.
      network: { allowedHosts: ['*'] },
      secrets: ['providers/exa/apiKey'],
    },
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { url } = args as { url: string };

      if (!url) return { ok: false, error: 'url is required', code: 'input_invalid' };

      const ssrf = await checkSsrf(url);
      if (ssrf.blocked) return { ok: false, error: ssrf.reason, code: 'execution_failed' };

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      try {
        const response = await net.fetch(url, {
          signal: ctx.abortSignal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ethos/1.0; +https://github.com/ethos)',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          },
        });

        if (!response.ok) {
          return {
            ok: false,
            error: `HTTP ${response.status} ${response.statusText}`,
            code: 'execution_failed',
          };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await response.text();
        const text = contentType.includes('html') ? htmlToText(body) : body;
        const header = `[${url}]\n\n`;

        const summarize = buildSummarize?.(ctx) ?? null;
        if (!summarize) {
          return { ok: true, value: header + text };
        }
        const result = await summarizeBySize(text, summarize);
        if ('tooLarge' in result) {
          return {
            ok: false,
            error: 'Page too large to extract (>2,000,000 chars)',
            code: 'execution_failed',
          };
        }
        return { ok: true, value: header + result.value };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebToolsOptions {
  searchBackend?: 'exa' | 'tavily' | 'brave';
  /** `web.searxng.url` — the keyless metasearch rung. Absent = not offered. */
  searxngUrl?: string;
  /**
   * Resolve the active personality's own `tools.yaml` web_search binding
   * (source of truth), keyed by personalityId. Wiring passes a lookup over
   * the personality registry.
   */
  resolvePersonalitySetting?: (personalityId: string) => WebSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { web_search?: WebSearchSetting } | undefined>;
  auxModel?: string;
  resolveProvider?: (model: string) => LLMProvider | null;
}

function buildSummarizeBuilder(
  opts: CreateWebToolsOptions,
): ((ctx: ToolContext) => ((chunk: string) => Promise<string>) | null) | undefined {
  const auxModel = opts.auxModel;
  if (!auxModel) return undefined;
  const buildPrompt = (chunk: string) =>
    `Extract and preserve the key factual content of the following web page. Be comprehensive but remove navigation, ads, and boilerplate. Return clean prose/markdown.\n\n${chunk}`;
  const provider = opts.resolveProvider ? opts.resolveProvider(auxModel) : null;
  return (ctx: ToolContext) => {
    if (provider) {
      return async (chunk: string): Promise<string> => {
        const stream = provider.complete(
          [{ role: 'user', content: [{ type: 'text', text: buildPrompt(chunk) }] }],
          [],
          { modelOverride: auxModel, abortSignal: ctx.abortSignal },
        );
        let out = '';
        for await (const ev of stream) {
          if (ev.type === 'text_delta') out += ev.text;
        }
        return out;
      };
    }
    const llm = ctx.llm;
    if (llm) {
      return async (chunk: string): Promise<string> =>
        llm.complete(buildPrompt(chunk), { model: auxModel });
    }
    return null;
  };
}

export function createWebTools(opts: CreateWebToolsOptions = {}): Tool[] {
  return [
    makeWebSearchTool({
      ...(opts.searchBackend ? { searchBackend: opts.searchBackend } : {}),
      ...(opts.searxngUrl ? { searxngUrl: opts.searxngUrl } : {}),
      ...(opts.resolvePersonalitySetting
        ? { resolvePersonalitySetting: opts.resolvePersonalitySetting }
        : {}),
      ...(opts.toolSettings ? { toolSettings: opts.toolSettings } : {}),
    }),
    makeWebExtractTool(buildSummarizeBuilder(opts)),
  ];
}

export const webSearchTool = makeWebSearchTool();
export const webExtractTool = makeWebExtractTool();

export { checkSsrf } from './ssrf';
