import { session } from 'electron';
import { getKeychainValue } from './keychain';
import { store } from './store';

// The single source of truth for "which backend are we talking to". Every base
// URL, cookie and CSP decision in the main process reads from here rather than
// re-deriving `http://localhost:${backendPort}` on its own.

export type ConnectionMode = 'local' | 'remote';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export function getConnectionMode(): ConnectionMode {
  return store.get('connectionMode') ?? 'local';
}

/**
 * Whether the user has answered "where should Ethos run" yet. An unset
 * `connectionMode` is the ONLY trigger for the first-run connection window —
 * once answered, in either direction, we never ask again.
 */
export function isConfigured(): boolean {
  return store.get('connectionMode') !== undefined;
}

/**
 * Normalizes a user-typed server URL to a bare origin (no trailing slash), or
 * null when it isn't an http(s) URL.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** Normalizes a remote server URL to its origin, or null if unparseable. */
export function remoteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The host (and port) of a remote server URL, for user-facing messages. */
export function remoteHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The websocket origin matching an http(s) origin — used by the remote CSP. */
export function wsOriginFor(origin: string): string {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return origin;
}

/** The base URL of whichever backend this app is currently pointed at. */
export function resolveBackendBaseUrl(): string {
  if (getConnectionMode() === 'remote') {
    const configured = store.get('remoteUrl');
    const url = configured ? normalizeRemoteUrl(configured) : null;
    if (!url) throw new Error('Remote URL not configured');
    return url;
  }
  return `http://127.0.0.1:${store.get('backendPort', 3001)}`;
}

/**
 * Writes the remote server's `ethos_auth` cookie from the keychain, so the
 * window can navigate to the remote SPA already authenticated.
 *
 * Deliberately NOT `/auth/exchange`: that route ROTATES the web token
 * (`apps/web-api/src/routes/auth.ts`), which would invalidate the value the
 * user pasted and make them re-enter it on every launch. Setting the cookie
 * directly is the same thing local mode does in `loadSpaUrl`, for the same
 * reason — it can never go stale.
 *
 * No-op outside remote mode, or when no URL/token has been stored.
 */
export async function applyRemoteAuthCookie(): Promise<void> {
  if (getConnectionMode() !== 'remote') return;
  const configured = store.get('remoteUrl');
  const url = configured ? normalizeRemoteUrl(configured) : null;
  if (!url) return;
  const token = await getKeychainValue('remote-token');
  if (!token) return;
  await session.defaultSession.cookies.set({
    url,
    name: 'ethos_auth',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Two probes: is the server there, and does the token work.
 *
 * The token probe hits an authenticated RPC method with the web-token cookie
 * and only distinguishes 401/403 from everything else — we are proving the
 * credential, not the response shape.
 */
export async function testConnection(url: string, token?: string): Promise<ConnectionTestResult> {
  const origin = normalizeRemoteUrl(url);
  if (!origin) return { ok: false, error: 'Enter an http:// or https:// server URL.' };

  const start = Date.now();
  let health: Response;
  try {
    health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const latencyMs = Date.now() - start;
  // 503 is a REACHABLE Ethos server whose gateway is down — the normal shape of
  // a serve-only deployment, and not a connection problem. Anything else means
  // we did not reach one.
  if (health.status !== 200 && health.status !== 503) {
    return { ok: false, error: `Server returned ${health.status}.`, latencyMs };
  }
  const version = await readVersion(health);
  const ok: ConnectionTestResult = { ok: true, latencyMs, ...(version ? { version } : {}) };
  if (!token) return ok;

  try {
    const res = await fetch(`${origin}/rpc/personalities/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `ethos_auth=${token}`,
        Origin: origin,
      },
      body: JSON.stringify({ json: {} }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Server rejected the token.', latencyMs };
    }
  } catch {
    // Reachability is already proven above, so a failure here is not the token
    // being refused — the only thing this probe is allowed to conclude.
  }
  return ok;
}

async function readVersion(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}
