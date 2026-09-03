// @vitest-environment jsdom
//
// `useMcpOAuthPopup` has no rendered output of its own, so the harness below
// mounts a component that calls the hook and stashes its latest return value
// in a module-level variable — the same "drive a real hook through a real
// render" approach `AddMcpModal.test.ts` uses for a full component, scaled
// down to just the hook.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseMcpOAuthPopupOptions, UseMcpOAuthPopupResult } from '../useMcpOAuthPopup';

const startFn = vi.fn();
const statusFn = vi.fn();
const cancelFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    mcp: {
      start: (...args: unknown[]) => startFn(...args),
      status: (...args: unknown[]) => statusFn(...args),
      cancel: (...args: unknown[]) => cancelFn(...args),
    },
  },
}));

const { useMcpOAuthPopup } = await import('../useMcpOAuthPopup');

let container: HTMLDivElement;
let root: Root;
let latest: UseMcpOAuthPopupResult | null = null;

function Harness(props: UseMcpOAuthPopupOptions) {
  latest = useMcpOAuthPopup(props);
  return null;
}

function mount(props: UseMcpOAuthPopupOptions): void {
  act(() => {
    root.render(createElement(Harness, props));
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let onSuccess: ReturnType<typeof vi.fn<UseMcpOAuthPopupOptions['onSuccess']>>;
let onError: ReturnType<typeof vi.fn<UseMcpOAuthPopupOptions['onError']>>;

beforeEach(() => {
  vi.clearAllMocks();
  latest = null;
  onSuccess = vi.fn<UseMcpOAuthPopupOptions['onSuccess']>();
  onError = vi.fn<UseMcpOAuthPopupOptions['onError']>();
  startFn.mockResolvedValue({
    ok: true,
    state: 'state-1',
    authorizeUrl: 'https://example.com/authorize',
    serverName: 'linear',
  });
  vi.stubGlobal(
    'open',
    vi.fn(() => ({ closed: false }) as unknown as Window),
  );
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useMcpOAuthPopup — start()', () => {
  it('opens the popup at 520x720 with the authorize URL, and threads personalityId when given', async () => {
    mount({ personalityId: 'agent-a', onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    expect(startFn).toHaveBeenCalledWith({
      url: 'https://mcp.linear.app/mcp',
      name: 'linear',
      personalityId: 'agent-a',
    });
    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/authorize',
      '_blank',
      'width=520,height=720',
    );
  });

  it('omits personalityId from mcp.start when none is configured', async () => {
    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });
    expect(startFn).toHaveBeenCalledWith({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
  });

  it('starts polling rpc.mcp.status() every 2 seconds once the popup is open', async () => {
    vi.useFakeTimers();
    statusFn.mockResolvedValue({ status: 'pending' });
    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    expect(statusFn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusFn).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusFn).toHaveBeenCalledTimes(2);
  });
});

describe('useMcpOAuthPopup — BroadcastChannel resolution', () => {
  it('a success broadcast with the matching state resolves onSuccess and stops polling', async () => {
    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    const channel = new BroadcastChannel('ethos:mcp_oauth');
    await act(async () => {
      channel.postMessage({
        type: 'ethos:mcp_oauth_success',
        state: 'state-1',
        serverName: 'linear',
      });
      await flushMicrotasks();
    });
    channel.close();

    expect(onSuccess).toHaveBeenCalledWith('linear');
    expect(onError).not.toHaveBeenCalled();
  });

  it('a broadcast with a mismatched state is ignored', async () => {
    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    const channel = new BroadcastChannel('ethos:mcp_oauth');
    await act(async () => {
      channel.postMessage({
        type: 'ethos:mcp_oauth_success',
        state: 'some-other-state',
        serverName: 'linear',
      });
      await flushMicrotasks();
    });
    channel.close();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(latest?.phase).toBe('waiting');
  });

  it('an error broadcast with the matching state resolves onError', async () => {
    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    const channel = new BroadcastChannel('ethos:mcp_oauth');
    await act(async () => {
      channel.postMessage({ type: 'ethos:mcp_oauth_error', state: 'state-1', detail: 'nope' });
      await flushMicrotasks();
    });
    channel.close();

    expect(onError).toHaveBeenCalledWith('nope');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('useMcpOAuthPopup — popup-blocked fallback', () => {
  it('sets the sessionStorage return key and navigates same-tab when the popup is blocked', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    const locationStub = { href: '', pathname: '/p/agent-a/mcp' };
    Object.defineProperty(window, 'location', { value: locationStub, writable: true });

    mount({ onSuccess, onError });
    await act(async () => {
      await latest?.start({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    });

    expect(sessionStorage.getItem('ethos:mcp_oauth_return')).toBe('/p/agent-a/mcp');
    expect(locationStub.href).toBe('https://example.com/authorize');
  });

  it('uses an explicit returnPath over the current pathname when given', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    const locationStub = { href: '', pathname: '/p/agent-a/mcp' };
    Object.defineProperty(window, 'location', { value: locationStub, writable: true });

    mount({ personalityId: 'agent-a', onSuccess, onError });
    await act(async () => {
      await latest?.start({
        url: 'https://mcp.linear.app/mcp',
        name: 'linear',
        returnPath: '/personalities/agent-a',
      });
    });

    expect(sessionStorage.getItem('ethos:mcp_oauth_return')).toBe('/personalities/agent-a');
  });
});
