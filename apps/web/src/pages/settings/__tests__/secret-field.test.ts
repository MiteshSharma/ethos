// @vitest-environment jsdom
//
// `SecretField` is the only write path onto the secrets vault from the Keys
// pane, so the cases here are its two safety rules and its three states —
// nothing about layout.
//
//   • A blank Save is a NO-OP. Clearing a credential is the Popconfirm-gated
//     destructive action and nothing else; a Save over an empty editor must
//     not reach the server at all, however it is triggered.
//   • A stored value is NEVER prefilled into the input. The preview is a
//     placeholder; the input's value is only ever what was just typed.
//
// Real DOM, because Antd's Popconfirm renders its confirm button into a portal
// on `document.body` only once the trigger is clicked — the same reason
// `components/mcp/__tests__/AddMcpModal.test.ts` runs under jsdom, and its
// `matchMedia` / `ResizeObserver` stubs are reused verbatim for the same two
// browser APIs Antd reaches for on mount.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KeyEntryView, SecretField } from '../components/secret-field';

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

const PREVIEW = 'sk-a…bc12';

function entry(over: Partial<KeyEntryView> = {}): KeyEntryView {
  return {
    id: 'tools.xai',
    category: 'tools',
    label: 'xAI (Grok + X search)',
    shape: 'single',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        ref: 'providers/xai/apiKey',
        preview: '<unset>',
        set: false,
      },
    ],
    set: false,
    canSet: true,
    canClear: true,
    ...over,
  };
}

/** The same entry with a value stored — the `masked` state. */
function storedEntry(over: Partial<KeyEntryView> = {}): KeyEntryView {
  return entry({
    set: true,
    fields: [
      { key: 'apiKey', label: 'API key', ref: 'providers/xai/apiKey', preview: PREVIEW, set: true },
    ],
    ...over,
  });
}

let container: HTMLDivElement;
let root: Root;

const onSave = vi.fn();
const onClear = vi.fn();

function mount(props: Partial<Parameters<typeof SecretField>[0]> & { entry: KeyEntryView }): void {
  act(() => {
    root.render(createElement(SecretField, { onSave, onClear, ...props }));
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'));
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(found, `missing button: ${text}`).toBeDefined();
  return found as HTMLButtonElement;
}

function hasButton(text: string): boolean {
  return buttons().some((b) => b.textContent?.trim() === text);
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
}

/** React tracks input state off the native setter, so bypass the wrapper. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

describe('the three states', () => {
  it('unset — offers Set, and nothing destructive to press', () => {
    mount({ entry: entry() });
    expect(container.textContent).toContain('Not set');
    expect(hasButton('Set')).toBe(true);
    expect(hasButton('Replace')).toBe(false);
    // Nothing is stored, so there is nothing to clear or to test.
    expect(hasButton('Clear')).toBe(false);
    expect(container.querySelectorAll('input').length).toBe(0);
  });

  it('masked — shows the preview and offers Replace and Clear, never the value', () => {
    mount({ entry: storedEntry() });
    expect(container.textContent).toContain(PREVIEW);
    expect(hasButton('Replace')).toBe(true);
    expect(hasButton('Clear')).toBe(true);
    expect(container.querySelectorAll('input').length).toBe(0);
  });

  it('editing — Replace opens an input, and Cancel closes it again', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Replace'));
    expect(container.querySelectorAll('input').length).toBe(1);
    expect(hasButton('Save')).toBe(true);

    await click(buttonByText('Cancel'));
    expect(container.querySelectorAll('input').length).toBe(0);
    expect(hasButton('Replace')).toBe(true);
  });

  it('read-only reflections offer no way to write — no Set, no Replace, no Clear', () => {
    mount({ entry: storedEntry({ canSet: false, canClear: false }) });
    expect(container.textContent).toContain(PREVIEW);
    expect(hasButton('Set')).toBe(false);
    expect(hasButton('Replace')).toBe(false);
    expect(hasButton('Clear')).toBe(false);
  });
});

describe('the stored value is never prefilled', () => {
  it('puts the preview in the placeholder and leaves the input empty', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Replace'));

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(PREVIEW);
    // Nothing anywhere in the rendered DOM carries the stored value as an
    // input value — the placeholder is the only place the preview appears.
    for (const el of Array.from(document.body.querySelectorAll('input'))) {
      expect(el.value).toBe('');
    }
  });
});

describe('a blank Save is a no-op', () => {
  it('disables Save on an empty editor and calls nothing if it is clicked anyway', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Replace'));

    const save = buttonByText('Save');
    expect(save.disabled).toBe(true);
    await click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('treats whitespace as blank', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Replace'));
    typeInto(container.querySelector('input') as HTMLInputElement, '   ');

    const save = buttonByText('Save');
    expect(save.disabled).toBe(true);
    await click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a real value, trimmed, keyed by the field key', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Replace'));
    typeInto(container.querySelector('input') as HTMLInputElement, '  xai-secret  ');
    await click(buttonByText('Save'));

    expect(onSave).toHaveBeenCalledWith({ apiKey: 'xai-secret' });
  });

  it('a multi-field credential is all-or-nothing', async () => {
    mount({
      entry: storedEntry({
        id: 'tools.reddit',
        label: 'Reddit',
        shape: 'multi',
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            ref: 'providers/reddit/client_id',
            preview: PREVIEW,
            set: true,
          },
          {
            key: 'clientSecret',
            label: 'Client secret',
            ref: 'providers/reddit/client_secret',
            preview: PREVIEW,
            set: true,
          },
        ],
      }),
    });
    await click(buttonByText('Replace'));

    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    expect(inputs.length).toBe(2);
    typeInto(inputs[0] as HTMLInputElement, 'only-the-id');

    const save = buttonByText('Save');
    expect(save.disabled).toBe(true);
    await click(save);
    expect(onSave).not.toHaveBeenCalled();

    typeInto(inputs[1] as HTMLInputElement, 'and-the-secret');
    await click(buttonByText('Save'));
    expect(onSave).toHaveBeenCalledWith({
      clientId: 'only-the-id',
      clientSecret: 'and-the-secret',
    });
  });
});

describe('Clear is Popconfirm-gated', () => {
  it('does not delete on the first click, only on the confirmation', async () => {
    mount({ entry: storedEntry() });
    await click(buttonByText('Clear'));
    expect(onClear).not.toHaveBeenCalled();

    const popup = document.body.querySelector('.ant-popconfirm');
    expect(popup, 'Clear opened no Popconfirm').not.toBeNull();
    await click(buttonByText('Clear', popup as ParentNode));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('the Test button follows the probe', () => {
  it('renders when the entry carries a probe and an onTest', () => {
    mount({ entry: storedEntry({ probe: 'exa' }), onTest: async () => ({ ok: true }) });
    expect(hasButton('Test')).toBe(true);
  });

  it('renders for no other entry, even when an onTest is handed in', () => {
    mount({ entry: storedEntry(), onTest: async () => ({ ok: true }) });
    expect(hasButton('Test')).toBe(false);
  });

  it('is absent when the entry has a probe but no handler', () => {
    mount({ entry: storedEntry({ probe: 'exa' }) });
    expect(hasButton('Test')).toBe(false);
  });

  it('reports what the probe said', async () => {
    mount({
      entry: storedEntry({ probe: 'exa' }),
      onTest: async () => ({ ok: false, error: 'rejected' }),
    });
    await click(buttonByText('Test'));
    expect(container.textContent).toContain('rejected');
  });
});
