// @vitest-environment jsdom
//
// The team Memory pane (teams-as-a-scope §8) over the `teams.memory*`
// wrappers: the topic list, reading the selected topic (`?topic=` or the
// first), and Edit → Save writing a `replace`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomShims } from './fixtures';

installDomShims();

const memoryList = vi.fn();
const memoryRead = vi.fn();
const memoryWrite = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: {
      memoryList: (...args: unknown[]) => memoryList(...args),
      memoryRead: (...args: unknown[]) => memoryRead(...args),
      memoryWrite: (...args: unknown[]) => memoryWrite(...args),
    },
  },
}));

const { TeamMemory } = await import('../TeamMemory');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(url: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [url] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/t/:teamId/memory', element: createElement(TeamMemory) }),
          ),
        ),
      ),
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}". Saw: ${container.textContent}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

const CONTENT: Record<string, string> = {
  onboarding: '# onboarding\nYou are one of four.',
  decisions: '# decisions\n2026-09-04 · Skip r/artificial.',
};

beforeEach(() => {
  vi.clearAllMocks();
  memoryList.mockResolvedValue({ items: [{ key: 'onboarding' }, { key: 'decisions' }] });
  memoryRead.mockImplementation(({ key }: { key: string }) =>
    Promise.resolve({ key, content: CONTENT[key] ?? '' }),
  );
  memoryWrite.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('TeamMemory', () => {
  it('lists topics and reads the first one by default', async () => {
    await mount('/t/marketing/memory');
    const rows = [...container.querySelectorAll('.team-toplist button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(rows).toEqual(['onboarding.md', 'decisions.md', '+ New topic']);
    expect(container.querySelector('.team-toplist-on')?.textContent).toContain('onboarding.md');
    expect(memoryList).toHaveBeenCalledWith({ team: 'marketing' });
    expect(memoryRead).toHaveBeenCalledWith({ team: 'marketing', key: 'onboarding' });
    expect(container.querySelector('.team-md')?.textContent).toBe(CONTENT.onboarding);
    expect(container.querySelector('.team-sec-cnt')?.textContent).toBe('team:marketing');
  });

  it('honours ?topic= and switches on click', async () => {
    await mount('/t/marketing/memory?topic=decisions');
    expect(container.querySelector('.team-toplist-on')?.textContent).toContain('decisions.md');
    expect(container.querySelector('.team-md')?.textContent).toBe(CONTENT.decisions);
    await click(button('onboarding.md'));
    expect(container.querySelector('.team-md')?.textContent).toBe(CONTENT.onboarding);
  });

  it('Edit → Save writes a replace with the edited content', async () => {
    await mount('/t/marketing/memory');
    await click(button('Edit'));
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('no textarea');
    expect(textarea.value).toBe(CONTENT.onboarding);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setter?.call(textarea, '# onboarding\nYou are one of five.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Save'));
    expect(memoryWrite).toHaveBeenCalledWith({
      team: 'marketing',
      key: 'onboarding',
      action: 'replace',
      content: '# onboarding\nYou are one of five.',
    });
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('shows the empty state when the team has no topics', async () => {
    memoryList.mockResolvedValue({ items: [] });
    await mount('/t/marketing/memory');
    expect(container.textContent).toContain('No topics yet.');
    expect(memoryRead).not.toHaveBeenCalled();
  });
});
