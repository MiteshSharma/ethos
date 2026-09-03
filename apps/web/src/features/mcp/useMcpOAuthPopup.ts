import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';

// Extracted from `ConnectMcpModal.tsx` (plan/phases/mcp-inline-catalog.md
// §1.2/§2.2/§6 step 3) — the popup/poll/`BroadcastChannel` mechanics for
// "start an MCP OAuth flow and wait for it to finish" were the one working
// copy of this in the codebase; the new inline catalog section needs the
// same thing, so this is a pure refactor first (same behavior, new internal
// shape), consumed by both `ConnectMcpModal` and `McpCatalogSection`.
// `PersonalityDetail.tsx` carries its own separate copy for a different job
// (re-authenticate an already-attached server) and is deliberately left
// alone — plan §3 "out of scope".

const OAUTH_POPUP_WIDTH = 520;
const OAUTH_POPUP_HEIGHT = 720;
const OAUTH_RETURN_KEY = 'ethos:mcp_oauth_return';
const OAUTH_MAX_WAIT_MS = 5 * 60 * 1000;
const OAUTH_POLL_INTERVAL_MS = 2000;

export interface UseMcpOAuthPopupOptions {
  /**
   * Threaded through to `rpc.mcp.start()` as `personalityId`, when set.
   * `install-flow.ts` uses it only to scope token storage — it never
   * attaches a personality to the server — so omitting it (as
   * `McpCatalogSection` does) keeps a one-click catalog registration
   * attach-free, per product decision 1 in the plan.
   */
  personalityId?: string;
  onSuccess: (serverName: string) => void;
  onError: (message: string) => void;
}

export interface UseMcpOAuthStartInput {
  url: string;
  name?: string;
  /** Same-tab fallback destination when the popup is blocked. Defaults to
   *  the current page (`window.location.pathname`) so a popup-blocked user
   *  returns to wherever they clicked from. */
  returnPath?: string;
}

export interface UseMcpOAuthPopupResult {
  /** Calls `rpc.mcp.start()`, opens the authorize popup (or falls back to a
   *  same-tab navigation if the popup is blocked), and starts polling for
   *  completion. Resolves once the attempt has been kicked off — success or
   *  failure of the flow itself arrives later via `onSuccess`/`onError`. */
  start: (input: UseMcpOAuthStartInput) => Promise<void>;
  /** `'connecting'` while `rpc.mcp.start()` is in flight; `'waiting'` once
   *  the popup is open (or the same-tab fallback has navigated away) and
   *  polling has begun; `'idle'` otherwise. */
  phase: 'idle' | 'connecting' | 'waiting';
  /** Stops polling and best-effort cancels the pending server-side state. */
  cancel: () => void;
}

export function useMcpOAuthPopup({
  personalityId,
  onSuccess,
  onError,
}: UseMcpOAuthPopupOptions): UseMcpOAuthPopupResult {
  const [oauthState, setOauthState] = useState('');
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'waiting'>('idle');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingStartRef = useRef(0);
  const serverNameRef = useRef('');

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const finish = useCallback(
    (serverName: string) => {
      stopPolling();
      setPhase('idle');
      setOauthState('');
      onSuccess(serverName || serverNameRef.current);
    },
    [stopPolling, onSuccess],
  );

  const fail = useCallback(
    (message: string) => {
      stopPolling();
      setPhase('idle');
      setOauthState('');
      onError(message);
    },
    [stopPolling, onError],
  );

  const startPolling = useCallback(() => {
    stopPolling();
    pollingStartRef.current = Date.now();
    pollingRef.current = setInterval(async () => {
      try {
        const result = await rpc.mcp.status();
        if (result.status === 'connected') {
          finish(result.serverName ?? '');
        } else if (result.status === 'error') {
          fail(result.error ?? 'Connection failed');
        } else if (result.status === 'expired') {
          if (Date.now() - pollingStartRef.current >= OAUTH_MAX_WAIT_MS) {
            fail('Authorization session expired. Please retry.');
          }
        }
      } catch {
        // Keep polling
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }, [stopPolling, finish, fail]);

  // Listen for the BroadcastChannel message from the OAuth callback page —
  // only while an attempt with a live `state` is outstanding.
  useEffect(() => {
    if (!oauthState) return;
    const channel = new BroadcastChannel('ethos:mcp_oauth');
    channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ethos:mcp_oauth_success' && msg.state === oauthState) {
        const name = typeof msg.serverName === 'string' ? msg.serverName : '';
        finish(name);
      } else if (msg.type === 'ethos:mcp_oauth_error' && msg.state === oauthState) {
        const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
        const code = typeof msg.code === 'string' ? msg.code : undefined;
        fail(detail ?? code ?? 'OAuth failed');
      }
    };
    return () => channel.close();
  }, [oauthState, finish, fail]);

  // Cleanup polling on unmount.
  useEffect(() => stopPolling, [stopPolling]);

  const cancel = useCallback(() => {
    stopPolling();
    if (oauthState) {
      rpc.mcp.cancel({ state: oauthState }).catch(() => {});
    }
    setOauthState('');
    setPhase('idle');
  }, [stopPolling, oauthState]);

  const start = useCallback(
    async ({ url, name, returnPath }: UseMcpOAuthStartInput) => {
      setPhase('connecting');
      try {
        const result = await rpc.mcp.start({
          url,
          ...(name ? { name } : {}),
          ...(personalityId ? { personalityId } : {}),
        });
        if (!result.ok) {
          fail('detail' in result ? (result.detail ?? result.code) : result.code);
          return;
        }
        serverNameRef.current = result.serverName;
        setOauthState(result.state);
        const popup = window.open(
          result.authorizeUrl,
          '_blank',
          `width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`,
        );
        if (!popup || popup.closed) {
          // Popup blocked — fall back to same-tab navigation.
          sessionStorage.setItem(OAUTH_RETURN_KEY, returnPath ?? window.location.pathname);
          setPhase('waiting');
          window.location.href = result.authorizeUrl;
          return;
        }
        setPhase('waiting');
        startPolling();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [personalityId, fail, startPolling],
  );

  return { start, phase, cancel };
}
