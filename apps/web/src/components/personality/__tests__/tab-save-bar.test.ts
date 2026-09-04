// @vitest-environment jsdom
//
// Saving in the personality Edit modal has to behave the same on every tab —
// that is the whole point of `TabSaveBar`. These cases assert the three things
// a user relies on: the bar says when there is something unsaved, the Plugins
// tab no longer writes behind their back, and closing with an unsaved draft
// asks first.
//
// Same jsdom + `react-dom/client` harness as `AddMcpModal.test.ts`: the repo
// has no testing-library, and Antd's Modal portals into `document.body`, so
// assertions run against the body rather than the render container.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two browser APIs jsdom does not implement that Antd's Modal/Tabs reach for
// on mount. Both are stubs — nothing here asserts on layout.
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

const getFn = vi.fn();
const characterSheetFn = vi.fn();
const updateFn = vi.fn();
const pluginsListFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    personalities: {
      get: (...args: unknown[]) => getFn(...args),
      characterSheet: (...args: unknown[]) => characterSheetFn(...args),
      update: (...args: unknown[]) => updateFn(...args),
    },
    plugins: {
      list: (...args: unknown[]) => pluginsListFn(...args),
    },
  },
}));

const { EditModal } = await import('../../../pages/Personalities');
const { TabSaveBar } = await import('../TabSaveBar');

const SOUL = 'I am the researcher.\n';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  getFn.mockReset();
  characterSheetFn.mockReset();
  updateFn.mockReset();
  pluginsListFn.mockReset();

  getFn.mockResolvedValue({
    personality: {
      id: 'researcher',
      name: 'Researcher',
      toolset: ['read_file'],
      plugins: ['alpha'],
    },
    soulMd: SOUL,
  });
  characterSheetFn.mockResolvedValue({ markdown: '# researcher', posture: null });
  updateFn.mockResolvedValue({ ok: true });
  pluginsListFn.mockResolvedValue({
    plugins: [
      {
        id: 'alpha',
        name: 'Alpha',
        source: 'local',
        pluginContractMajor: 1,
        description: 'first',
      },
      {
        id: 'beta',
        name: 'Beta',
        source: 'local',
        pluginContractMajor: 1,
        description: 'second',
      },
    ],
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/** Let react-query settle a query or a mutation. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountModal(onClose: () => void = () => {}): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AntApp, null, createElement(EditModal, { id: 'researcher', onClose })),
      ),
    );
  });
  await flush();
}

async function openTab(label: string): Promise<void> {
  const tab = Array.from(document.body.querySelectorAll('.ant-tabs-tab-btn')).find(
    (el) => el.textContent?.trim() === label,
  );
  expect(tab, `missing tab: ${label}`).toBeDefined();
  act(() => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `missing button: ${text}`).toBeDefined();
  return button as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

/** React tracks textarea state off the native setter, so bypass the wrapper. */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TabSaveBar', () => {
  function renderBar(props: {
    dirty: boolean;
    saving: boolean;
    saveSucceeded: boolean;
    onDirtyChange?: (dirty: boolean) => void;
  }): void {
    act(() => {
      root.render(createElement(TabSaveBar, { ...props, onSave: () => {} }));
    });
  }

  it('disables Save and says nothing while clean and never saved', () => {
    renderBar({ dirty: false, saving: false, saveSucceeded: false });
    expect(buttonByText('Save').disabled).toBe(true);
    expect(container.textContent).not.toContain('Unsaved changes');
    expect(container.textContent).not.toContain('Saved');
  });

  it('announces unsaved changes and enables Save when dirty', () => {
    renderBar({ dirty: true, saving: false, saveSucceeded: false });
    expect(container.textContent).toContain('Unsaved changes');
    expect(buttonByText('Save').disabled).toBe(false);
  });

  it('confirms the save once clean again, and drops it on the next edit', () => {
    renderBar({ dirty: false, saving: false, saveSucceeded: true });
    expect(container.textContent).toContain('Saved');
    renderBar({ dirty: true, saving: false, saveSucceeded: true });
    expect(container.textContent).not.toContain('Saved');
    expect(container.textContent).toContain('Unsaved changes');
  });

  it('reports dirty upward, and reports clean when the pane goes away', () => {
    const seen: boolean[] = [];
    const onDirtyChange = (d: boolean) => seen.push(d);
    renderBar({ dirty: true, saving: false, saveSucceeded: false, onDirtyChange });
    expect(seen.at(-1)).toBe(true);
    act(() => root.render(null));
    expect(seen.at(-1)).toBe(false);
  });
});

describe('Identity tab', () => {
  it('goes dirty on edit and clean again after the save lands', async () => {
    await mountModal();
    await openTab('Identity');

    const textarea = document.body.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(document.body.textContent).not.toContain('Unsaved changes');

    typeInto(textarea as HTMLTextAreaElement, `${SOUL}And I read carefully.\n`);
    expect(document.body.textContent).toContain('Unsaved changes');

    await click(buttonByText('Save'));

    expect(updateFn).toHaveBeenCalledWith({
      id: 'researcher',
      soulMd: `${SOUL}And I read carefully.\n`,
    });
    expect(document.body.textContent).not.toContain('Unsaved changes');
    expect(document.body.textContent).toContain('Saved');
  });
});

describe('Plugins tab', () => {
  it('holds a toggle as a draft and only writes when Save is pressed', async () => {
    await mountModal();
    await openTab('Plugins');

    const toggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach Beta to researcher"]',
    );
    expect(toggle).not.toBeNull();

    await click(toggle as HTMLButtonElement);
    expect(updateFn).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Unsaved changes');

    await click(buttonByText('Save'));
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith({ id: 'researcher', plugins: ['alpha', 'beta'] });
    expect(document.body.textContent).not.toContain('Unsaved changes');
  });
});

describe('close guard', () => {
  it('closes straight away when no tab is dirty', async () => {
    const onClose = vi.fn();
    await mountModal(onClose);
    await openTab('Identity');

    const close = document.body.querySelector('.ant-modal-close');
    expect(close).not.toBeNull();
    await click(close as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Discard unsaved changes?');
  });

  // Antd `Tabs` keeps a pane mounted once it has been activated, and the modal's
  // `destroyOnClose` only fires on close — so a draft has to survive a look at
  // another tab. If either default ever changes, this is what catches it.
  it('keeps a draft, and its dirty state, across a tab switch', async () => {
    const onClose = vi.fn();
    await mountModal(onClose);
    await openTab('Identity');
    typeInto(document.body.querySelector('textarea') as HTMLTextAreaElement, 'a new soul');

    await openTab('Toolset');
    await openTab('Identity');

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('a new soul');

    await click(document.body.querySelector('.ant-modal-close') as Element);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Discard unsaved changes?');
  });

  it('asks before discarding when a tab is dirty', async () => {
    const onClose = vi.fn();
    await mountModal(onClose);
    await openTab('Identity');

    const textarea = document.body.querySelector('textarea');
    typeInto(textarea as HTMLTextAreaElement, 'rewritten');

    const close = document.body.querySelector('.ant-modal-close');
    await click(close as Element);

    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Discard unsaved changes?');

    await click(buttonByText('Discard'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
