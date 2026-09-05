// @vitest-environment jsdom
//
// The Recipes gallery (plan/phases/recipes-gallery.md §5). Drives the real
// component in jsdom, the same approach as `pages/__tests__/Mcp.test.ts`.
//
// Two things are asserted here. The catalog renders as a CARD GRID — a
// recorded exception to DESIGN.md's "cards earn existence" rule, approved by
// the user on 2026-09-04 after seeing both this and the stacked-row version
// (see the DESIGN.md decisions log). The cards are raw primitives and real
// links, so the Antd `Card` primitive is still absent and each card keeps
// keyboard focus. And the install status is DERIVED from whether the bundle's
// personality exists (D8 — there is no install ledger to read).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
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

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
    createElement('a', { href: to, className }, children),
}));

const listFn = vi.fn();
const getFn = vi.fn();
const personalitiesListFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    recipes: {
      list: (...args: unknown[]) => listFn(...args),
      get: (...args: unknown[]) => getFn(...args),
    },
    personalities: {
      list: (...args: unknown[]) => personalitiesListFn(...args),
    },
  },
}));

const { Recipes } = await import('../Recipes');

const CATALOG = {
  recipes: [
    {
      id: 'morning-briefing',
      version: 2,
      title: 'Morning briefing',
      summary: 'A digest before you wake up.',
      tags: ['daily', 'needs-channel'],
      sourceDoc: 'plan/usecases/01-morning-briefing.md',
      attachedTo: null,
    },
    {
      id: 'link-archiver',
      version: 1,
      title: 'Link archiver',
      summary: 'Saves and summarizes every link you send it.',
      tags: ['zero-credentials'],
      sourceDoc: null,
      attachedTo: null,
    },
    {
      id: 'obsidian-second-brain',
      version: 1,
      title: 'Obsidian second brain',
      summary: 'Gives a personality you already have your vault.',
      tags: ['attach'],
      sourceDoc: null,
      attachedTo: ['writer', 'researcher'],
    },
  ],
};

function bundleFor(id: string, personalityId: string) {
  return {
    recipe: {
      id,
      version: 1,
      title: id,
      summary: '',
      tags: [],
      personality:
        id === 'obsidian-second-brain'
          ? {
              mode: 'both' as const,
              id: personalityId,
              name: personalityId,
              description: '',
              soulMd: '',
              toolset: [],
              attach: { soulSection: 'Vault rules.', toolset: [] },
            }
          : {
              mode: 'create' as const,
              id: personalityId,
              name: personalityId,
              description: '',
              soulMd: '',
              toolset: [],
            },
      requires: { mcpServers: [], plugins: [], channels: [], tools: [], inputs: [] },
      cronJobs: [],
      starterPrompt: '',
      examplePrompts: [],
      notes: [],
      postInstall: [],
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Recipes)));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  listFn.mockResolvedValue(CATALOG);
  getFn.mockImplementation((input: { id: string }) =>
    Promise.resolve(bundleFor(input.id, input.id === 'morning-briefing' ? 'briefer' : 'archivist')),
  );
  personalitiesListFn.mockResolvedValue({ items: [{ id: 'briefer', name: 'Briefer' }] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('Recipes gallery', () => {
  it('lists every recipe as a card linking to its detail view', async () => {
    await mount();

    const cards = container.querySelectorAll('a.recipe-card');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute('href')).toBe('/recipes/morning-briefing');
    expect(cards[1]?.getAttribute('href')).toBe('/recipes/link-archiver');
    expect(container.textContent).toContain('Morning briefing');
    expect(container.textContent).toContain('Saves and summarizes every link you send it.');
    expect(container.textContent).toContain('3 recipes');
  });

  it('renders one card grid, built from primitives rather than the Card primitive', async () => {
    await mount();

    expect(container.querySelectorAll('.recipes-grid')).toHaveLength(1);
    // The grid is the approved exception; the `Card` primitive is not part of
    // it. Every card is an anchor, so it is focusable and middle-clickable.
    expect(container.querySelector('.ant-card')).toBeNull();
    expect([...container.querySelectorAll('.recipe-card')].every((el) => el.tagName === 'A')).toBe(
      true,
    );
  });

  it('derives the status from whether the bundle personality exists', async () => {
    await mount();

    const statuses = [...container.querySelectorAll('.recipe-card-status')].map(
      (el) => el.textContent,
    );
    // A create recipe: does its personality exist. A both recipe whose own
    // personality does not exist but whose section two others carry: attached
    // — the server's `attachedTo` row.
    expect(statuses).toEqual(['✓ Installed', 'Install', '✓ Attached']);
    expect(container.textContent).toContain('attached to writer, researcher');
  });

  it('says so plainly when the catalog is empty', async () => {
    listFn.mockResolvedValue({ recipes: [] });
    await mount();

    expect(container.textContent).toContain('No recipes are shipped in this build');
    expect(container.querySelector('a.recipe-card')).toBeNull();
  });
});
