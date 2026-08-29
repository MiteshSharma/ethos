import { beforeEach, describe, expect, it } from 'vitest';
import { _clearTokenCacheForTests } from '../auth';
import { createRedditSearchTool, redditSearchTool } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-x-search/src/__tests__/x-search.test.ts's
// mockSecrets/mockFetch/ctx conventions (plain-object ScopedSecretsResolver +
// ScopedFetch stubs, never a real network call).
// ---------------------------------------------------------------------------

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const CREDENTIALS: Record<string, string> = {
  'providers/reddit/client_id': 'test-client-id',
  'providers/reddit/client_secret': 'test-client-secret',
};

const mockSecrets = {
  get: async (ref: string) => CREDENTIALS[ref] ?? '',
};

const noCredsSecrets = {
  get: async (_ref: string) => '',
};

const baseCtx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

const ctxWithoutCapabilities = { ...baseCtx };

function tokenResponse(token = 'tok-1') {
  return { access_token: token, expires_in: 3600 };
}

function redditPost(overrides: Record<string, unknown> = {}) {
  return {
    title: 'How do you market on Reddit without getting banned?',
    selftext: 'Long post body about marketing strategies and subreddit rules.',
    subreddit: 'marketing',
    author: 'someuser',
    score: 42,
    num_comments: 7,
    created_utc: 1735689600, // 2025-01-01T00:00:00Z
    permalink: '/r/marketing/comments/abc123/how_do_you_market/',
    ...overrides,
  };
}

/**
 * A ScopedFetch stub that routes requests by host: the token endpoint gets
 * `tokenBody`/`tokenStatus`, the search endpoint gets `searchBody`/`searchStatus`.
 * Records every call for assertion.
 */
function makeRoutedFetch(opts: {
  tokenBody?: unknown;
  tokenStatus?: number;
  searchBody?: unknown;
  searchStatus?: number;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, init });
    if (urlStr.includes('www.reddit.com/api/v1/access_token')) {
      return new Response(JSON.stringify(opts.tokenBody ?? tokenResponse()), {
        status: opts.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(opts.searchBody ?? { data: { children: [] } }), {
      status: opts.searchStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

function ctxWith(scopedFetch: ScopedFetchLike, secrets = mockSecrets) {
  return { ...baseCtx, scopedFetch, secretsResolver: secrets };
}

beforeEach(() => {
  _clearTokenCacheForTests();
});

// ---------------------------------------------------------------------------

describe('reddit_search — availability', () => {
  it('isAvailable always returns true, regardless of credential presence', () => {
    expect(redditSearchTool.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await redditSearchTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

describe('reddit_search — input validation', () => {
  it('returns input_invalid if query is missing', async () => {
    const result = await redditSearchTool.execute({}, ctxWith(makeRoutedFetch({}).scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('reddit_search — missing credentials', () => {
  it('produces a clear not_available error pointing at Tool settings, before any network call', async () => {
    const rec = makeRoutedFetch({});
    const result = await redditSearchTool.execute(
      { query: 'q' },
      ctxWith(rec.scopedFetch, noCredsSecrets),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/tool settings/i);
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('reddit_search — successful search', () => {
  it('searches site-wide with default params', async () => {
    const rec = makeRoutedFetch({
      searchBody: { data: { children: [{ data: redditPost() }] } },
    });
    const result = await redditSearchTool.execute(
      { query: 'reddit marketing' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);

    const searchCall = rec.calls.find((c) => c.url.includes('oauth.reddit.com'));
    expect(searchCall).toBeDefined();
    const url = new URL(searchCall?.url ?? '');
    expect(url.hostname).toBe('oauth.reddit.com');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('reddit marketing');
    expect(url.searchParams.get('sort')).toBe('relevance');
    expect(url.searchParams.get('t')).toBe('week');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('restrict_sr')).toBe(false);

    const headers = new Headers(searchCall?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('scopes to a subreddit and sets restrict_sr=1', async () => {
    const rec = makeRoutedFetch({
      searchBody: { data: { children: [{ data: redditPost() }] } },
    });
    await redditSearchTool.execute(
      { query: 'q', subreddit: 'marketing' },
      ctxWith(rec.scopedFetch),
    );

    const searchCall = rec.calls.find((c) => c.url.includes('oauth.reddit.com'));
    const url = new URL(searchCall?.url ?? '');
    expect(url.pathname).toBe('/r/marketing/search');
    expect(url.searchParams.get('restrict_sr')).toBe('1');
  });

  it('passes through time_filter, sort, and limit (capped at 25)', async () => {
    const rec = makeRoutedFetch({
      searchBody: { data: { children: [{ data: redditPost() }] } },
    });
    await redditSearchTool.execute(
      { query: 'q', time_filter: 'month', sort: 'top', limit: 100 },
      ctxWith(rec.scopedFetch),
    );

    const searchCall = rec.calls.find((c) => c.url.includes('oauth.reddit.com'));
    const url = new URL(searchCall?.url ?? '');
    expect(url.searchParams.get('t')).toBe('month');
    expect(url.searchParams.get('sort')).toBe('top');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('formats results as a numbered list with title, subreddit, engagement, permalink, date, snippet', async () => {
    const rec = makeRoutedFetch({
      searchBody: { data: { children: [{ data: redditPost() }] } },
    });
    const result = await redditSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('1. **How do you market on Reddit without getting banned?**');
    expect(result.value).toContain('r/marketing');
    expect(result.value).toContain('42 points, 7 comments');
    expect(result.value).toContain(
      'https://reddit.com/r/marketing/comments/abc123/how_do_you_market/',
    );
    expect(result.value).toContain('2025-01-01');
    expect(result.value).toContain('Long post body about marketing strategies');
  });

  it('returns a "no results" message when the search returns zero posts', async () => {
    const rec = makeRoutedFetch({ searchBody: { data: { children: [] } } });
    const result = await redditSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('No results found for: q');
  });
});

describe('reddit_search — auth failure handling', () => {
  it('retries once on a 401 from the search call, then succeeds with a fresh token', async () => {
    let searchCallCount = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, init });
      if (urlStr.includes('www.reddit.com/api/v1/access_token')) {
        return new Response(JSON.stringify(tokenResponse(`tok-${calls.length}`)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      searchCallCount += 1;
      if (searchCallCount === 1) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: { children: [{ data: redditPost() }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await redditSearchTool.execute({ query: 'q' }, ctxWith({ fetch }));
    expect(result.ok).toBe(true);
    expect(searchCallCount).toBe(2);
    // One token fetch up front, one more after the 401 (refreshAccessToken).
    const tokenCalls = calls.filter((c) => c.url.includes('access_token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('surfaces execution_failed when the retry after a 401 also fails', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, init });
      if (urlStr.includes('www.reddit.com/api/v1/access_token')) {
        return new Response(JSON.stringify(tokenResponse(`tok-${calls.length}`)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    };

    const result = await redditSearchTool.execute({ query: 'q' }, ctxWith({ fetch }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('401');
    }
  });

  it('surfaces execution_failed on a non-401 API error, without retrying', async () => {
    const rec = makeRoutedFetch({ searchBody: { message: 'Internal error' }, searchStatus: 500 });
    const result = await redditSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('500');
    }
    const searchCalls = rec.calls.filter((c) => c.url.includes('oauth.reddit.com'));
    expect(searchCalls).toHaveLength(1);
  });
});

describe('reddit_search — capability declarations', () => {
  it('declares capabilities.network.allowedHosts = [oauth.reddit.com, www.reddit.com]', () => {
    expect(redditSearchTool.capabilities.network?.allowedHosts).toEqual([
      'oauth.reddit.com',
      'www.reddit.com',
    ]);
  });

  it('declares capabilities.secrets for both client_id and client_secret refs', () => {
    expect(redditSearchTool.capabilities.secrets).toEqual([
      'providers/reddit/client_id',
      'providers/reddit/client_secret',
    ]);
  });

  it('declares toolset "web"', () => {
    expect(redditSearchTool.toolset).toBe('web');
  });

  it('marks output as untrusted', () => {
    expect(redditSearchTool.outputIsUntrusted).toBe(true);
  });
});

describe('reddit_search settingsSchema', () => {
  it('declares two secret-binding fields, both required, with distinct secretKinds and shared helpText', () => {
    const schema = redditSearchTool.settingsSchema;
    if (!schema) throw new Error('expected reddit_search to declare a settingsSchema');
    expect(schema.fields).toHaveLength(2);

    const [clientIdField, clientSecretField] = schema.fields;
    if (clientIdField?.kind !== 'secret-binding' || clientSecretField?.kind !== 'secret-binding') {
      throw new Error('expected both fields to be secret-binding');
    }

    expect(clientIdField.key).toBe('client_id');
    expect(clientIdField.secretKind).toBe('reddit-client-id');
    expect(clientIdField.required).toBe(true);

    expect(clientSecretField.key).toBe('client_secret');
    expect(clientSecretField.secretKind).toBe('reddit-client-secret');
    expect(clientSecretField.required).toBe(true);

    expect(clientIdField.helpText).toBeTruthy();
    expect(clientIdField.helpText).toBe(clientSecretField.helpText);
    expect(clientIdField.helpText).toContain('reddit.com/prefs/apps');
    expect(clientIdField.helpText).toContain('client_id');
    expect(clientIdField.helpText).toContain('client_secret');
  });
});

describe('createRedditSearchTool', () => {
  it('returns a fresh tool instance with the same shape as the default export', () => {
    const tool = createRedditSearchTool();
    expect(tool.name).toBe('reddit_search');
    expect(tool.settingsSchema).toEqual(redditSearchTool.settingsSchema);
  });
});
