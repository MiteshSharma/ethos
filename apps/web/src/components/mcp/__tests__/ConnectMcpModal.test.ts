// @vitest-environment jsdom
//
// No test existed for this modal before the `useMcpOAuthPopup` extraction
// (plan/phases/mcp-inline-catalog.md §6 step 3) — this covers the behavior
// the refactor must preserve: attach-then-authorize for an OAuth server,
// attach-only for one that doesn't need it.

import type { McpServerInfo } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const listFn = vi.fn();
const updateFn = vi.fn();
const startFn = vi.fn();
const statusFn = vi.fn();
const cancelFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    mcp: {
      list: (...args: unknown[]) => listFn(...args),
      start: (...args: unknown[]) => startFn(...args),
      status: (...args: unknown[]) => statusFn(...args),
      cancel: (...args: unknown[]) => cancelFn(...args),
    },
    personalities: {
      update: (...args: unknown[]) => updateFn(...args),
    },
  },
}));

const { ConnectMcpModal } = await import('../ConnectMcpModal');

const SERVERS: McpServerInfo[] = [
  {
    name: 'context7',
    transport: 'streamable-http',
    command: null,
    url: 'https://mcp.context7.com/mcp',
    auth_status: 'none',
    created_via: 'ui',
    mcpResultLimitChars: null,
    deprecated: null,
  },
  {
    name: 'linear',
    transport: 'streamable-http',
    command: null,
    url: 'https://mcp.linear.app/mcp',
    auth_status: 'missing',
    created_via: 'ui',
    mcpResultLimitChars: null,
    deprecated: null,
  },
];

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ConnectMcpModal, {
          open: true,
          personalityId: 'agent-a',
          existingServers: [],
          onClose: () => {},
          onConnected: () => {},
        }),
      ),
    );
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function connectButtonFor(serverName: string): HTMLButtonElement {
  const item = Array.from(document.body.querySelectorAll('.ant-list-item')).find((el) =>
    el.textContent?.includes(serverName),
  );
  expect(item, `missing list item: ${serverName}`).toBeDefined();
  const button = item?.querySelector('button') as HTMLButtonElement | undefined;
  expect(button, `missing connect button for: ${serverName}`).toBeDefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  // React only flushes async `act(...)` work when it knows it is under test.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listFn.mockResolvedValue({ servers: SERVERS });
  updateFn.mockResolvedValue({ ok: true });
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ConnectMcpModal', () => {
  it('attaches a non-OAuth server and finishes without opening a popup', async () => {
    mount();
    await flush();

    await act(async () => {
      connectButtonFor('context7').click();
      await flush();
    });

    expect(updateFn).toHaveBeenCalledWith({
      id: 'agent-a',
      mcp_servers: ['context7'],
    });
    expect(startFn).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('context7 connected');
  });

  it('attaches an OAuth server, then starts OAuth with the server name and personalityId', async () => {
    mount();
    await flush();

    await act(async () => {
      connectButtonFor('linear').click();
      await flush();
    });

    expect(updateFn).toHaveBeenCalledWith({
      id: 'agent-a',
      mcp_servers: ['linear'],
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
    expect(document.body.textContent).toContain('Complete sign-in in the new window');
  });
});
