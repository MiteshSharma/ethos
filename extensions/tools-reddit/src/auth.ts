// ---------------------------------------------------------------------------
// OAuth2 client-credentials token fetch + in-memory cache/refresh for
// Reddit's official API. See plan/phases/reddit-research-tool.md.
//
// Reddit blocks generic/missing User-Agent headers — every request (token
// fetch AND search) carries a fixed, descriptive one identifying this tool.
// This doesn't need to be dynamically configurable per Reddit's own policy:
// a static, honest User-Agent is what's asked for.
// ---------------------------------------------------------------------------

export const REDDIT_USER_AGENT = 'ethos:reddit-search:1.0 (by /u/ethos-agent)';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

/** Minimal fetch shape — matches `ScopedFetch.fetch` from `@ethosagent/types`. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token is considered expired and must be refetched. */
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

// Refetch a little before the server-declared expiry so a token doesn't go
// stale mid-request.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

/**
 * In-memory token cache, keyed by the `client_id:client_secret` pair in use.
 * A single process can see different personalities' Reddit credentials
 * across calls (credentials are resolved per-call via `ctx.secretsResolver`,
 * not a single global config), so the cache must not assume one fixed pair
 * for the module's lifetime.
 */
const tokenCache = new Map<string, CachedToken>();

function cacheKey(clientId: string, clientSecret: string): string {
  return `${clientId}:${clientSecret}`;
}

async function requestToken(
  clientId: string,
  clientSecret: string,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
): Promise<CachedToken> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Reddit token request failed: HTTP ${response.status} ${body}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error(`Reddit token request failed: ${data.error ?? 'no access_token in response'}`);
  }

  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - EXPIRY_SAFETY_MARGIN_MS, 0),
  };
}

/**
 * Returns a cached, non-expired access token for the given credentials,
 * fetching (and caching) a fresh one if none is cached or the cached one
 * has expired.
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  const key = cacheKey(clientId, clientSecret);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const fresh = await requestToken(clientId, clientSecret, fetchFn, signal);
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}

/**
 * Forces a fresh token fetch for the given credentials, replacing any cached
 * value. Used to retry once after a 401 from a search call, in case the
 * cached token was revoked or expired early.
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  const fresh = await requestToken(clientId, clientSecret, fetchFn, signal);
  tokenCache.set(cacheKey(clientId, clientSecret), fresh);
  return fresh.accessToken;
}

/** Test-only: clear the module-level token cache between test cases. */
export function _clearTokenCacheForTests(): void {
  tokenCache.clear();
}
