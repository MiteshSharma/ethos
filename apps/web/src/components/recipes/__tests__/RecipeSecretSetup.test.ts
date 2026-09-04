// @vitest-environment jsdom
//
// The recipe flow's credential step. The behaviour under test is the whole
// point of the change: a user who ALREADY has a search key picks it from a
// dropdown instead of pasting a new one, and the answer that leaves this
// component is a REFERENCE (provider + secret name), never a value.
//
// Antd's Select renders its option list into a portal on `document.body` only
// once open, so assertions run against `document.body` — same shape as
// `AddMcpModal.test.ts`.

import type { RecipePreflight } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { namedSecretKeys } from '../../../features/settings/api/keys';

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

const namedSecretsCreateFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    namedSecrets: {
      list: () => Promise.resolve({ secrets: [] }),
      create: (...args: unknown[]) => namedSecretsCreateFn(...args),
    },
  },
}));

const { RecipeSecretSetup } = await import('../RecipeSecretSetup');

type NeedsInputRow = RecipePreflight['needsInput'][number];

/** The row preflight emits for `web_search`'s key on a machine without one. */
const ROW: NeedsInputRow = {
  key: 'secret:web_search',
  label: 'Web search API key',
  kind: 'credential',
  help: 'The briefing searches the web. Any one of: Exa, Tavily.',
  secretKind: 'web-search',
  credentialOptions: [
    {
      provider: 'exa',
      label: 'Exa',
      defaultSecretName: 'apiKey',
      getKeyUrl: 'https://example.invalid/exa',
    },
    { provider: 'tavily', label: 'Tavily', defaultSecretName: 'apiKey' },
  ],
};

const VAULT = [
  { provider: 'exa' as const, name: 'work', preview: '…aa11', kind: 'web-search' as const },
  { provider: 'exa' as const, name: 'personal', preview: '…bb22', kind: 'web-search' as const },
  { provider: 'tavily' as const, name: 'apiKey', preview: '…cc33', kind: 'web-search' as const },
];

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

function mount(secrets: typeof VAULT): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(namedSecretKeys.all(), { secrets });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RecipeSecretSetup, { row: ROW, binding: null, onChange }),
      ),
    );
  });
}

function fire(el: Element, type: string): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

/** Open the nth Antd Select. 0 is the provider, 1 is the secret picker. */
function openSelect(index: number): void {
  const selector = document.body.querySelectorAll('.ant-select-content')[index];
  expect(selector, `missing select #${index}`).toBeDefined();
  if (selector) fire(selector, 'mousedown');
}

function optionTexts(): string[] {
  return Array.from(document.body.querySelectorAll('.ant-select-item-option')).map((el) =>
    (el.textContent ?? '').trim(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('RecipeSecretSetup', () => {
  it('offers the vault keys for the chosen provider, and answers with a reference', () => {
    mount(VAULT);
    openSelect(1);

    // Filtered to the selected provider (`exa`), so a Tavily key can never be
    // bound to an Exa-shaped call.
    const texts = optionTexts();
    expect(texts.some((t) => t.includes('work'))).toBe(true);
    expect(texts.some((t) => t.includes('personal'))).toBe(true);
    expect(texts.some((t) => t.includes('apiKey'))).toBe(false);

    const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find(
      (el) => el.textContent?.includes('work'),
    );
    expect(option).toBeDefined();
    if (option) fire(option, 'click');

    // A NAME and a provider. Nothing that could be a credential.
    expect(onChange).toHaveBeenCalledWith({ provider: 'exa', secret: 'work' });
    expect(namedSecretsCreateFn).not.toHaveBeenCalled();
  });

  it('offers the add-a-key path when the vault holds none', () => {
    mount([]);
    openSelect(1);

    expect(document.body.textContent).toContain('No secrets yet');
    const add = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add secret'),
    );
    expect(add, 'missing "+ Add secret"').toBeDefined();
    if (add) fire(add, 'click');

    // The add form is the vault's own — it is what writes the value, and it is
    // the only place in this flow a value is ever typed.
    expect(document.body.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('draws no password field of its own', () => {
    // The bespoke "paste the key" input this replaced. A user with a key
    // already in the vault should never be asked to produce a second one.
    mount(VAULT);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('Pick a key');
  });
});
