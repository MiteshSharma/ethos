// T4 — the SearXNG rung. `web.searxng.url` is an optional, keyless extra rung
// for `web_search`: neither `web.search_backend` nor the personality
// `tools.yaml` binding can name it (both are typed to the three keyed
// providers), so it is reached by having no keyed backend available.
//
// Revert `selectBackend`'s trailing `return searxng ? { searxng } : null` to
// `return null` and every test in the first block fails with "No web search
// provider is configured".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebTools } from '../index';

const SEARCH_ENV_KEYS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of SEARCH_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SEARCH_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function ctxWith(
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
  secret: string | null = null,
) {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    secretsResolver: { get: async () => secret },
    scopedFetch: { fetch },
    // biome-ignore lint/suspicious/noExplicitAny: web_search reads only these fields
  } as any;
}

function recordingFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string | URL): Promise<Response> => {
      calls.push(typeof url === 'string' ? url : url.toString());
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

const RESULTS = {
  results: [
    { title: 'First', url: 'https://a.example/1', content: 'body one' },
    { title: 'Second', url: 'https://b.example/2', content: 'body two' },
  ],
};

describe('web_search — SearXNG rung', () => {
  it('returns results from the configured instance when no keyed provider has a key', async () => {
    const rec = recordingFetch(RESULTS);
    const tool = createWebTools({ searxngUrl: 'https://searx.internal' })[0];

    const result = await tool.execute({ query: 'quantum' }, ctxWith(rec.fetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('via searxng');
    expect(result.value).toContain('https://a.example/1');
    expect(result.value).toContain('https://b.example/2');

    expect(rec.calls).toHaveLength(1);
    const called = new URL(rec.calls[0] ?? '');
    expect(called.origin + called.pathname).toBe('https://searx.internal/search');
    expect(called.searchParams.get('q')).toBe('quantum');
    expect(called.searchParams.get('format')).toBe('json');
  });

  it('honours a trailing slash / sub-path in the instance URL', async () => {
    const rec = recordingFetch(RESULTS);
    const tool = createWebTools({ searxngUrl: 'https://host.example/searx/' })[0];
    await tool.execute({ query: 'q' }, ctxWith(rec.fetch));
    expect(new URL(rec.calls[0] ?? '').pathname).toBe('/searx/search');
  });

  it('caps the result list at num_results', async () => {
    const rec = recordingFetch(RESULTS);
    const tool = createWebTools({ searxngUrl: 'https://searx.internal' })[0];
    const result = await tool.execute({ query: 'q', num_results: 1 }, ctxWith(rec.fetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('https://a.example/1');
    expect(result.value).not.toContain('https://b.example/2');
  });

  it('adds the instance host to the tool capability allowlist, and nothing else', () => {
    const tool = createWebTools({ searxngUrl: 'https://searx.internal:8888/' })[0];
    expect(tool.capabilities?.network?.allowedHosts).toEqual([
      'api.exa.ai',
      'api.tavily.com',
      'api.search.brave.com',
      'searx.internal:8888',
    ]);
  });

  it('offers no rung at all when web.searxng.url is unset', async () => {
    const rec = recordingFetch(RESULTS);
    const tool = createWebTools({})[0];
    const result = await tool.execute({ query: 'q' }, ctxWith(rec.fetch));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(rec.calls).toHaveLength(0);
  });

  it('is a LAST rung — a keyed provider with a key still wins', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    const rec = recordingFetch({
      web: { results: [{ title: 'B', url: 'https://brave.example' }] },
    });
    const tool = createWebTools({ searxngUrl: 'https://searx.internal' })[0];
    const result = await tool.execute({ query: 'q' }, ctxWith(rec.fetch, 'brave-key'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('via brave');
    expect(rec.calls[0]).toContain('api.search.brave.com');
  });
});

describe('web_search — an unreachable or broken SearXNG instance', () => {
  it('names the instance when the connection fails', async () => {
    const tool = createWebTools({ searxngUrl: 'https://searx.down' })[0];
    const result = await tool.execute(
      { query: 'q' },
      ctxWith(async () => {
        throw new Error('fetch failed');
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('searx.down');
    expect(result.error).toContain('web.searxng.url');
  });

  it('reports a non-2xx answer with its status', async () => {
    const rec = recordingFetch({ error: 'nope' }, 502);
    const tool = createWebTools({ searxngUrl: 'https://searx.internal' })[0];
    const result = await tool.execute({ query: 'q' }, ctxWith(rec.fetch));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('502');
    expect(result.error).toContain('searx.internal');
  });

  it('does not offer the rung at all for an unparseable instance URL', async () => {
    const rec = recordingFetch(RESULTS);
    const tool = createWebTools({ searxngUrl: 'not a url' })[0];
    const result = await tool.execute({ query: 'q' }, ctxWith(rec.fetch));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
  });
});
