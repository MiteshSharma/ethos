import { beforeEach, describe, expect, it } from 'vitest';
import { _clearTokenCacheForTests } from '../auth';
import { createRedditThreadTool, parseRedditPostId, redditThreadTool } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — same mockSecrets / makeRoutedFetch / baseCtx conventions as
// reddit-search.test.ts (plain-object ScopedSecretsResolver + ScopedFetch
// stubs, never a real network call).
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

const POST_URL = 'https://www.reddit.com/r/marketing/comments/abc123/how_do_you_market/';

function tokenResponse(token = 'tok-1') {
  return { access_token: token, expires_in: 3600 };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    title: 'How do you market on Reddit without getting banned?',
    selftext: 'Long post body about marketing strategies and subreddit rules.',
    subreddit: 'marketing',
    author: 'someuser',
    score: 42,
    upvote_ratio: 0.91,
    num_comments: 7,
    created_utc: 1735689600, // 2025-01-01T00:00:00Z
    permalink: '/r/marketing/comments/abc123/how_do_you_market/',
    url: 'https://www.reddit.com/r/marketing/comments/abc123/how_do_you_market/',
    link_flair_text: 'Discussion',
    over_18: false,
    locked: true,
    ...overrides,
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    kind: 't1',
    data: {
      author: 'alice',
      body: 'Top comment',
      score: 10,
      created_utc: 1735776000, // 2025-01-02
      depth: 0,
      replies: '',
      distinguished: null,
      stickied: false,
      is_submitter: false,
      ...overrides,
    },
  };
}

function listing(children: unknown[]) {
  return { kind: 'Listing', data: { children } };
}

/** Post + a three-level comment chain (alice → bob → carol), a deleted comment, and a `more` node. */
function threadResponse(postOverrides: Record<string, unknown> = {}) {
  return [
    listing([{ kind: 't3', data: post(postOverrides) }]),
    listing([
      comment({
        author: 'alice',
        body: 'Top comment\nspanning lines',
        is_submitter: true,
        replies: listing([
          comment({
            author: 'bob',
            body: 'Mod reply',
            score: 3,
            depth: 1,
            distinguished: 'moderator',
            stickied: true,
            replies: listing([
              comment({ author: 'carol', body: 'Deep reply', score: 1, depth: 2 }),
            ]),
          }),
        ]),
      }),
      comment({ author: '[deleted]', body: '[removed]' }),
      { kind: 'more', data: { count: 12, children: ['d1', 'd2'] } },
    ]),
  ];
}

/**
 * A ScopedFetch stub that routes requests by host: the token endpoint gets
 * `tokenBody`/`tokenStatus`, the thread endpoint gets `threadBody`/`threadStatus`.
 * Records every call for assertion.
 */
function makeRoutedFetch(opts: {
  tokenBody?: unknown;
  tokenStatus?: number;
  threadBody?: unknown;
  threadStatus?: number;
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
    return new Response(JSON.stringify(opts.threadBody ?? threadResponse()), {
      status: opts.threadStatus ?? 200,
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

describe('parseRedditPostId', () => {
  it('parses a full www.reddit.com URL', () => {
    expect(parseRedditPostId(POST_URL)).toBe('abc123');
  });

  it('parses an old.reddit.com URL', () => {
    expect(parseRedditPostId('https://old.reddit.com/r/marketing/comments/abc123/slug/')).toBe(
      'abc123',
    );
  });

  it('parses a bare /r/.../comments/<id>/ path', () => {
    expect(parseRedditPostId('/r/marketing/comments/abc123/how_do_you_market/')).toBe('abc123');
  });

  it('parses a bare id', () => {
    expect(parseRedditPostId('abc123')).toBe('abc123');
  });

  it('parses a t3_ fullname', () => {
    expect(parseRedditPostId('t3_abc123')).toBe('abc123');
  });

  it('returns null for garbage', () => {
    expect(parseRedditPostId('')).toBeNull();
    expect(parseRedditPostId('not a reddit link')).toBeNull();
    expect(parseRedditPostId('https://example.com/r/foo/')).toBeNull();
  });
});

describe('reddit_thread — availability and input', () => {
  it('isAvailable always returns true, regardless of credential presence', () => {
    expect(redditThreadTool.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await redditThreadTool.execute({ permalink: POST_URL }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('returns input_invalid when the permalink cannot be parsed', async () => {
    const rec = makeRoutedFetch({});
    const result = await redditThreadTool.execute(
      { permalink: 'https://example.com/nothing' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toContain('https://example.com/nothing');
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('reddit_thread — missing credentials', () => {
  it('produces a clear not_available error naming reddit_thread, before any network call', async () => {
    const rec = makeRoutedFetch({});
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch, noCredsSecrets),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/tool settings/i);
      expect(result.error).toContain('reddit_thread');
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('reddit_thread — happy path', () => {
  it('renders the post header, selftext, and nested comments with indentation and counts', async () => {
    const rec = makeRoutedFetch({});
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# How do you market on Reddit without getting banned?');
    expect(result.value).toContain(
      'r/marketing | u/someuser | 42 points (91% upvoted) | 7 comments | 2025-01-01',
    );
    expect(result.value).toContain('Flair: Discussion');
    expect(result.value).toContain('Flags: locked');
    expect(result.value).toContain(
      'https://reddit.com/r/marketing/comments/abc123/how_do_you_market/',
    );
    expect(result.value).toContain('Long post body about marketing strategies');

    // Two rendered (alice, bob); carol is beyond the default depth of 2;
    // the deleted comment is skipped; the `more` node's count is reported.
    expect(result.value).toContain('## Comments (2 shown, 12 more not loaded)');
    expect(result.value).toContain('- u/alice (10 pts, OP) 2025-01-02: Top comment spanning lines');
    expect(result.value).toContain('\n  - u/bob (3 pts, mod, stickied) 2025-01-02: Mod reply');
    expect(result.value).not.toContain('u/carol');
    expect(result.value).not.toContain('[deleted]');
  });

  it('says "No comments yet." when the comment listing is empty', async () => {
    const rec = makeRoutedFetch({
      threadBody: [listing([{ kind: 't3', data: post() }]), listing([])],
    });
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('No comments yet.');
  });

  it('renders replies deeper than the default when depth is raised', async () => {
    const rec = makeRoutedFetch({});
    const result = await redditThreadTool.execute(
      { permalink: POST_URL, depth: 3 },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('\n    - u/carol (1 pts) 2025-01-02: Deep reply');
      expect(result.value).toContain('## Comments (3 shown, 12 more not loaded)');
    }
  });

  it('accepts a bare id and requests the right URL with limit/depth/raw_json', async () => {
    const rec = makeRoutedFetch({});
    await redditThreadTool.execute(
      { permalink: 't3_abc123', limit: 500, depth: 4 },
      ctxWith(rec.scopedFetch),
    );

    const apiCalls = rec.calls.filter((c) => !c.url.includes('access_token'));
    expect(apiCalls).toHaveLength(1);
    const url = new URL(apiCalls[0]?.url ?? '');
    expect(url.hostname).toBe('oauth.reddit.com');
    expect(url.pathname).toBe('/comments/abc123');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('depth')).toBe('4');
    expect(url.searchParams.get('sort')).toBe('top');
    expect(url.searchParams.get('raw_json')).toBe('1');

    const headers = new Headers(apiCalls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
    expect(headers.get('User-Agent')).toBeTruthy();
  });

  it('uses default limit and depth when none are given', async () => {
    const rec = makeRoutedFetch({});
    await redditThreadTool.execute({ permalink: POST_URL }, ctxWith(rec.scopedFetch));
    const apiCall = rec.calls.find((c) => c.url.includes('oauth.reddit.com'));
    const url = new URL(apiCall?.url ?? '');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('depth')).toBe('2');
  });
});

describe('reddit_thread — auth', () => {
  it('reuses the cached token across two calls (token endpoint hit once)', async () => {
    const rec = makeRoutedFetch({});
    await redditThreadTool.execute({ permalink: POST_URL }, ctxWith(rec.scopedFetch));
    await redditThreadTool.execute({ permalink: POST_URL }, ctxWith(rec.scopedFetch));

    const tokenCalls = rec.calls.filter((c) => c.url.includes('access_token'));
    expect(tokenCalls).toHaveLength(1);
    const apiCalls = rec.calls.filter((c) => c.url.includes('oauth.reddit.com'));
    expect(apiCalls).toHaveLength(2);
  });

  it('retries once on a 401, then succeeds with a fresh token', async () => {
    let apiCallCount = 0;
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
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify(threadResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await redditThreadTool.execute({ permalink: POST_URL }, ctxWith({ fetch }));
    expect(result.ok).toBe(true);
    expect(apiCallCount).toBe(2);
    const tokenCalls = calls.filter((c) => c.url.includes('access_token'));
    expect(tokenCalls).toHaveLength(2);

    const retry = calls.filter((c) => c.url.includes('oauth.reddit.com'))[1];
    const headers = new Headers(retry?.init?.headers);
    expect(headers.get('Authorization')).not.toBe('Bearer tok-1');
  });
});

describe('reddit_thread — API errors', () => {
  it('adds approval/private-subreddit guidance on 403', async () => {
    const rec = makeRoutedFetch({ threadBody: { message: 'Forbidden' }, threadStatus: 403 });
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('Reddit API error 403');
      expect(result.error).toContain('private/quarantined');
    }
  });

  it('adds rate-limit guidance on 429', async () => {
    const rec = makeRoutedFetch({ threadBody: { message: 'Too Many' }, threadStatus: 429 });
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('Reddit API error 429');
      expect(result.error).toContain('100 requests/min');
    }
  });

  it('surfaces execution_failed on a plain non-OK status, without retrying', async () => {
    const rec = makeRoutedFetch({ threadBody: { message: 'Internal error' }, threadStatus: 500 });
    const result = await redditThreadTool.execute(
      { permalink: POST_URL },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('500');
    }
    expect(rec.calls.filter((c) => c.url.includes('oauth.reddit.com'))).toHaveLength(1);
  });

  it('surfaces execution_failed when fetch throws', async () => {
    const fetch = async (url: string | URL): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('access_token')) {
        return new Response(JSON.stringify(tokenResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('network down');
    };
    const result = await redditThreadTool.execute({ permalink: POST_URL }, ctxWith({ fetch }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toBe('network down');
    }
  });
});

describe('reddit_thread — capability declarations', () => {
  it('mirrors reddit_search: hosts, secret refs, toolset, untrusted output, settingsSchema', () => {
    expect(redditThreadTool.capabilities.network?.allowedHosts).toEqual([
      'oauth.reddit.com',
      'www.reddit.com',
    ]);
    expect(redditThreadTool.capabilities.secrets).toEqual([
      'providers/reddit/client_id',
      'providers/reddit/client_secret',
    ]);
    expect(redditThreadTool.toolset).toBe('web');
    expect(redditThreadTool.outputIsUntrusted).toBe(true);
    expect(redditThreadTool.maxResultChars).toBe(20_000);

    const schema = redditThreadTool.settingsSchema;
    if (!schema) throw new Error('expected reddit_thread to declare a settingsSchema');
    expect(schema.fields).toHaveLength(2);
    const [clientIdField, clientSecretField] = schema.fields;
    if (clientIdField?.kind !== 'secret-binding' || clientSecretField?.kind !== 'secret-binding') {
      throw new Error('expected both fields to be secret-binding');
    }
    expect(clientIdField.secretKind).toBe('reddit-client-id');
    expect(clientSecretField.secretKind).toBe('reddit-client-secret');
    expect(clientIdField.helpText).toContain('reddit.com/prefs/apps');
  });
});

describe('createRedditThreadTool', () => {
  it('returns a fresh tool instance with the same shape as the default export', () => {
    const tool = createRedditThreadTool();
    expect(tool.name).toBe('reddit_thread');
    expect(tool.settingsSchema).toEqual(redditThreadTool.settingsSchema);
  });
});
