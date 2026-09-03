// @vitest-environment jsdom
//
// `WorkspaceMcpPanel` (the `/p/:personalityId/mcp` branch of `<Mcp/>`) gained
// a third section — the inline catalog — in
// plan/phases/mcp-inline-catalog.md §2.5. This drives the real component in
// jsdom (same approach as `pages/__tests__/activity-page.test.ts`) to prove
// all three sections render, in order, with the right counts, off the two
// queries the panel already runs (no new fetch for the catalog section).

import type { McpCatalogOutput, McpServerInfo } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { rpc } from '../../rpc';

/** The per-personality attachment rows are a narrower shape than the global
 *  `McpServerInfo` list — no exported alias for them, so take the typed
 *  client's inferred return type (same pattern as `features/voice/*`). */
type AttachedServers = Awaited<ReturnType<typeof rpc.mcp.personalityServers>>['servers'];

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

vi.mock('react-router-dom', () => ({ useParams: () => ({ personalityId: 'agent-a' }) }));

const personalityServersFn = vi.fn();
const pluginsListFn = vi.fn();
const catalogFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    mcp: {
      personalityServers: (...args: unknown[]) => personalityServersFn(...args),
      catalog: (...args: unknown[]) => catalogFn(...args),
    },
    plugins: {
      list: (...args: unknown[]) => pluginsListFn(...args),
    },
  },
}));

const { Mcp } = await import('../Mcp');

const ATTACHED: AttachedServers = [
  { name: 'attached-one', transport: 'streamable-http', auth_status: 'authorized' },
];

const GLOBAL_SERVERS: McpServerInfo[] = [
  {
    name: 'attached-one',
    transport: 'streamable-http',
    command: null,
    url: 'https://example.com/attached-one',
    auth_status: 'authorized',
    created_via: 'ui',
    mcpResultLimitChars: null,
    deprecated: null,
  },
  {
    name: 'installed-two',
    transport: 'streamable-http',
    command: null,
    url: 'https://example.com/installed-two',
    auth_status: 'none',
    created_via: 'ui',
    mcpResultLimitChars: null,
    deprecated: null,
  },
];

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
      description: 'Read and update Linear issues',
      category: 'Productivity',
    },
  ],
  local: [],
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Mcp)));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  personalityServersFn.mockResolvedValue({ servers: ATTACHED });
  pluginsListFn.mockResolvedValue({ mcpServers: GLOBAL_SERVERS });
  catalogFn.mockResolvedValue(CATALOG);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('WorkspaceMcpPanel — three sections', () => {
  it('renders Attached, Installed-not-attached and Catalog, in that order, with correct counts', async () => {
    await mount();

    const text = container.textContent ?? '';
    const attachedIdx = text.indexOf('Attached (1)');
    const notAttachedIdx = text.indexOf('Installed, not attached (1)');
    const catalogIdx = text.indexOf('Catalog (2)');

    expect(attachedIdx).toBeGreaterThanOrEqual(0);
    expect(notAttachedIdx).toBeGreaterThan(attachedIdx);
    expect(catalogIdx).toBeGreaterThan(notAttachedIdx);
  });

  it('places each server/preset in exactly the section it belongs to', async () => {
    await mount();

    // The attached server's own row shows in the Attached table, not the
    // catalog section — its name still appears once overall.
    expect(container.textContent).toContain('attached-one');
    expect(container.textContent).toContain('installed-two');
    // Neither catalog entry collides with an already-registered name, so
    // both remain in the Catalog section.
    expect(container.textContent).toContain('Context7');
    expect(container.textContent).toContain('Linear');
  });
});
