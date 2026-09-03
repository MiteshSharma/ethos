// @vitest-environment jsdom
//
// Same rendering approach as `AddMcpModal.test.ts`: the catalog is seeded
// into the query cache rather than fetched, and assertions run against
// `document.body` because Antd portals (and here, `AntApp`'s notification
// holder) render outside the mount container.

import type { McpCatalogOutput } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpKeys } from '../../../features/mcp/api/keys';

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

const catalogFn = vi.fn();
const addServerFn = vi.fn();
const startFn = vi.fn();
const statusFn = vi.fn();
const cancelFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    mcp: {
      catalog: (...args: unknown[]) => catalogFn(...args),
      addServer: (...args: unknown[]) => addServerFn(...args),
      start: (...args: unknown[]) => startFn(...args),
      status: (...args: unknown[]) => statusFn(...args),
      cancel: (...args: unknown[]) => cancelFn(...args),
    },
  },
}));

const { McpCatalogSection } = await import('../McpCatalogSection');

const CATALOG: McpCatalogOutput = {
  remote: [
    {
      name: 'context7',
      label: 'Context7',
      url: 'https://mcp.context7.com/mcp',
      transport: 'streamable-http',
      authType: 'none',
      description: 'Up-to-date library documentation',
      category: 'Docs & knowledge',
    },
    {
      name: 'linear',
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authType: 'oauth',
      description: 'Read and update Linear issues, projects, and cycles',
      category: 'Productivity',
    },
    {
      name: 'wolfram',
      label: 'Wolfram',
      url: 'https://mcp.wolframalpha.com/mcp',
      transport: 'streamable-http',
      authType: 'bearer',
      description: 'Computational knowledge queries',
      category: 'Docs & knowledge',
    },
  ],
  local: [],
};

let container: HTMLDivElement;
let root: Root;

function mount(registeredNames: Set<string> = new Set()): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(mcpKeys.catalog(), CATALOG);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AntApp, null, createElement(McpCatalogSection, { registeredNames })),
      ),
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
  expect(button, `missing button: ${text}`).toBeDefined();
  return button as HTMLButtonElement;
}

/** The row containing `label` — used to scope a button lookup to one row. */
function rowFor(label: string): HTMLElement {
  const strong = Array.from(document.body.querySelectorAll('strong')).find(
    (el) => el.textContent === label,
  );
  expect(strong, `missing row: ${label}`).toBeDefined();
  const row = strong?.closest('div[style*="align-items"]') as HTMLElement | null;
  expect(row, `missing row wrapper for: ${label}`).not.toBeNull();
  return row as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  addServerFn.mockResolvedValue({ ok: true, serverName: 'x' });
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

describe('McpCatalogSection — rendering', () => {
  it('renders catalog entries grouped by category, with description and auth badge', () => {
    mount();

    const groupLabels = Array.from(document.body.querySelectorAll('.ant-typography')).map((el) =>
      el.textContent?.trim(),
    );
    expect(groupLabels).toContain('Docs & knowledge');
    expect(groupLabels).toContain('Productivity');

    expect(document.body.textContent).toContain('Context7');
    expect(document.body.textContent).toContain('Up-to-date library documentation');
    expect(document.body.textContent).toContain('No auth');

    expect(document.body.textContent).toContain('Linear');
    expect(document.body.textContent).toContain('OAuth');

    expect(document.body.textContent).toContain('Wolfram');
    expect(document.body.textContent).toContain('API key');
  });

  it('labels the action button "Add" for none/bearer and "Connect" for oauth', () => {
    mount();
    expect(rowFor('Context7').textContent).toContain('Add');
    expect(rowFor('Wolfram').textContent).toContain('Add');
    expect(rowFor('Linear').textContent).toContain('Connect');
  });

  it('omits an entry whose name is already registered', () => {
    mount(new Set(['linear']));
    expect(document.body.textContent).not.toContain('Linear');
    expect(document.body.textContent).toContain('Context7');
    expect(document.body.textContent).toContain('Wolfram');
  });

  it('renders nothing when every entry is already registered', () => {
    mount(new Set(['context7', 'linear', 'wolfram']));
    expect(document.body.textContent?.trim()).toBe('');
  });
});

describe('McpCatalogSection — click behavior', () => {
  it('none entry: addServer with authType none, no token, no form', async () => {
    mount();
    await act(async () => {
      buttonByText('Add').click();
      await Promise.resolve();
    });
    // Both "Add" buttons render (context7, wolfram); the first is context7.
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'context7',
      url: 'https://mcp.context7.com/mcp',
      transport: 'streamable-http',
      authType: 'none',
    });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('bearer entry: addServer with authType bearer, no token', async () => {
    mount();
    const wolframRow = rowFor('Wolfram');
    const button = wolframRow.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'wolfram',
      url: 'https://mcp.wolframalpha.com/mcp',
      transport: 'streamable-http',
      authType: 'bearer',
    });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('oauth entry: start with { url, name }, no personalityId, then opens the popup', async () => {
    mount();
    await act(async () => {
      buttonByText('Connect').click();
      await Promise.resolve();
    });
    expect(startFn).toHaveBeenCalledWith({
      url: 'https://mcp.linear.app/mcp',
      name: 'linear',
    });
    expect(addServerFn).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/authorize',
      '_blank',
      'width=520,height=720',
    );
  });
});
