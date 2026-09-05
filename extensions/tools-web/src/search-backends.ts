import type { SecretRef, ToolContext } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Search backend contract — one per provider (Exa, Tavily, Brave)
// ---------------------------------------------------------------------------

export interface SearchHit {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

/** Actionable "no key" message naming the provider and where to set one. */
const NO_KEY_MESSAGE = (provider: 'exa' | 'tavily' | 'brave'): string =>
  `No ${provider} key configured — add one in Settings > Named Secrets (or set the ${provider.toUpperCase()}_API_KEY env var).`;

export interface SearchBackend {
  id: 'exa' | 'tavily' | 'brave';
  host: string;
  secretRef: SecretRef;
  isAvailable(): boolean;
  /**
   * `secretRef` is the resolved secret reference for this call — the default
   * `providers/<id>/apiKey`, or a personality-bound `providers/<id>/<name>`
   * named secret. The caller (`selectBackend`) resolves it; the backend only
   * reads the ref it is handed.
   */
  search(
    query: string,
    numResults: number,
    ctx: ToolContext,
    secretRef: SecretRef,
  ): Promise<SearchHit[]>;
}

// ---------------------------------------------------------------------------
// Exa — POST https://api.exa.ai/search
// ---------------------------------------------------------------------------

export const exaBackend: SearchBackend = {
  id: 'exa',
  host: 'api.exa.ai',
  secretRef: 'providers/exa/apiKey',
  isAvailable: () => Boolean(process.env.EXA_API_KEY),
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('exa'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const response = await net.fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: 1500 } } }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Exa API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      results: Array<{ title?: string; url: string; text?: string; publishedDate?: string }>;
    };
    return data.results ?? [];
  },
};

// ---------------------------------------------------------------------------
// Tavily — POST https://api.tavily.com/search
// ---------------------------------------------------------------------------

export const tavilyBackend: SearchBackend = {
  id: 'tavily',
  host: 'api.tavily.com',
  secretRef: 'providers/tavily/apiKey',
  isAvailable: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('tavily'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const response = await net.fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: numResults,
        include_answer: false,
        search_depth: 'basic',
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Tavily API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url: string; content?: string; published_date?: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      text: r.content,
      publishedDate: r.published_date,
    }));
  },
};

// ---------------------------------------------------------------------------
// Brave — GET https://api.search.brave.com/res/v1/web/search
// ---------------------------------------------------------------------------

export const braveBackend: SearchBackend = {
  id: 'brave',
  host: 'api.search.brave.com',
  secretRef: 'providers/brave/apiKey',
  isAvailable: () => Boolean(process.env.BRAVE_API_KEY),
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('brave'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${numResults}`;
    const response = await net.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Brave API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{ title?: string; url: string; description?: string; page_age?: string }>;
      };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      text: r.description,
      publishedDate: r.page_age,
    }));
  },
};

export const ALL_BACKENDS: SearchBackend[] = [exaBackend, tavilyBackend, braveBackend];

// ---------------------------------------------------------------------------
// SearXNG — GET <instance>/search?q=…&format=json
// ---------------------------------------------------------------------------

/**
 * A self-hosted metasearch instance. Deliberately NOT a `SearchBackend`: it
 * takes no API key, so it has no `secretRef` and its `search` has nothing to
 * do with the vault. Giving it a ref it never resolves would put a dead
 * namespace in `web_search`'s capability grant.
 */
export interface KeylessSearchBackend {
  id: 'searxng';
  host: string;
  search(query: string, numResults: number, ctx: ToolContext): Promise<SearchHit[]>;
}

/**
 * Build the SearXNG rung for `web.searxng.url`. Returns `null` for a URL that
 * is not parseable — the rung is simply not offered, exactly as if it were
 * unconfigured, rather than failing every later search.
 */
export function createSearxngBackend(instanceUrl: string): KeylessSearchBackend | null {
  let base: URL;
  try {
    base = new URL(instanceUrl);
  } catch {
    return null;
  }
  const endpoint = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);

  return {
    id: 'searxng',
    host: base.host,
    async search(query, numResults, ctx): Promise<SearchHit[]> {
      const net = ctx.scopedFetch;
      if (!net) throw new Error('scopedFetch not configured');

      const url = new URL(endpoint.href);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');

      let response: Response;
      try {
        response = await net.fetch(url.href, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: ctx.abortSignal,
        });
      } catch (err) {
        // A self-hosted endpoint being down or misspelled is the expected
        // failure here, and a bare "fetch failed" names nothing the operator
        // can fix. Say which instance.
        throw new Error(
          `SearXNG instance ${base.host} is unreachable (web.searxng.url): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`SearXNG error ${response.status} from ${base.host}: ${body}`);
      }

      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url: string;
          content?: string;
          publishedDate?: string;
        }>;
      };
      return (data.results ?? []).slice(0, numResults).map((r) => ({
        title: r.title,
        url: r.url,
        text: r.content,
        publishedDate: r.publishedDate,
      }));
    },
  };
}
