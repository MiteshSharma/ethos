import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearTokenCacheForTests,
  getAccessToken,
  REDDIT_USER_AGENT,
  refreshAccessToken,
} from '../auth';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-x-search/src/__tests__/x-search.test.ts's
// recording-fetch convention.
// ---------------------------------------------------------------------------

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

beforeEach(() => {
  _clearTokenCacheForTests();
});

describe('getAccessToken — caching', () => {
  it('fetches a token once and reuses it across repeated calls with the same credentials', async () => {
    const rec = makeRecordingFetch({ access_token: 'tok-1', expires_in: 3600 });

    const first = await getAccessToken('id', 'secret', rec.fetch);
    const second = await getAccessToken('id', 'secret', rec.fetch);

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(rec.calls).toHaveLength(1);
  });

  it('fetches separately for different credential pairs', async () => {
    const rec = makeRecordingFetch({ access_token: 'tok-shared', expires_in: 3600 });

    await getAccessToken('id-a', 'secret-a', rec.fetch);
    await getAccessToken('id-b', 'secret-b', rec.fetch);

    expect(rec.calls).toHaveLength(2);
  });

  it('refetches once the cached token has expired', async () => {
    // expires_in of 1s minus the 30s safety margin floors to 0 — the token is
    // considered expired immediately, so the next call must refetch.
    const rec = makeRecordingFetch({ access_token: 'tok-expiring', expires_in: 1 });

    const first = await getAccessToken('id', 'secret', rec.fetch);
    const second = await getAccessToken('id', 'secret', rec.fetch);

    expect(first).toBe('tok-expiring');
    expect(second).toBe('tok-expiring');
    expect(rec.calls).toHaveLength(2);
  });
});

describe('refreshAccessToken', () => {
  it('always fetches a fresh token and replaces the cache, for retry-on-401', async () => {
    const rec1 = makeRecordingFetch({ access_token: 'tok-old', expires_in: 3600 });
    await getAccessToken('id', 'secret', rec1.fetch);
    expect(rec1.calls).toHaveLength(1);

    const rec2 = makeRecordingFetch({ access_token: 'tok-new', expires_in: 3600 });
    const refreshed = await refreshAccessToken('id', 'secret', rec2.fetch);
    expect(refreshed).toBe('tok-new');
    expect(rec2.calls).toHaveLength(1);

    // Cache now holds the refreshed token.
    const cachedAgain = await getAccessToken('id', 'secret', rec2.fetch);
    expect(cachedAgain).toBe('tok-new');
    expect(rec2.calls).toHaveLength(1);
  });
});

describe('token request shape', () => {
  it('sends the correct headers and body to the token endpoint', async () => {
    const rec = makeRecordingFetch({ access_token: 'tok-1', expires_in: 3600 });
    await getAccessToken('my-id', 'my-secret', rec.fetch);

    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call?.url).toBe('https://www.reddit.com/api/v1/access_token');
    expect(call?.init?.method).toBe('POST');

    const headers = new Headers(call?.init?.headers);
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('my-id:my-secret').toString('base64')}`,
    );
    expect(headers.get('User-Agent')).toBe(REDDIT_USER_AGENT);
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(call?.init?.body).toBe('grant_type=client_credentials');
  });

  it('surfaces a clear error on a non-ok token response', async () => {
    const rec = makeRecordingFetch({ error: 'invalid_grant' }, 401);
    await expect(getAccessToken('id', 'secret', rec.fetch)).rejects.toThrow(/401/);
  });

  it('surfaces a clear error when the response has no access_token', async () => {
    const rec = makeRecordingFetch({ error: 'unauthorized_client' }, 200);
    await expect(getAccessToken('id', 'secret', rec.fetch)).rejects.toThrow(/unauthorized_client/);
  });
});
