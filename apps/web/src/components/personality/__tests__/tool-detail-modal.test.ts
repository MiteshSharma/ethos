// @vitest-environment jsdom
//
// The tool inspector exists for one finding: a personality listing a tool this
// deployment does not have. The registry filters unavailable tools out of the
// catalog, so if this alert stops rendering nothing else in the UI says so.
//
// The other three cases guard the safety-shaped bits: the button never
// promises a run the server will refuse, the mutation never fires on mount
// (it can EXECUTE a tool), and a real execution's output is shown.
//
// Same jsdom + `react-dom/client` harness as `tab-save-bar.test.ts` — the repo
// has no testing-library, and Antd's Modal portals into `document.body`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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

const detailFn = vi.fn();
const testFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    tools: {
      detail: (...args: unknown[]) => detailFn(...args),
      test: (...args: unknown[]) => testFn(...args),
    },
  },
}));

const { ToolDetailModal } = await import('../ToolDetailModal');

/** A registered, healthy tool. Cases override only what they are about. */
function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    name: 'read_file',
    description: 'Reads a file from disk.',
    toolset: 'file',
    group: 'File',
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    capabilities: { fs_reach: { read: 'from-personality' } },
    hasSettingsSchema: false,
    registered: true,
    available: true,
    inPersonalityToolset: true,
    testEligibility: { canRun: true },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  detailFn.mockReset();
  testFn.mockReset();
  detailFn.mockResolvedValue(baseDetail());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountModal(toolName = 'read_file'): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AntApp,
          null,
          createElement(ToolDetailModal, {
            toolName,
            personalityId: 'researcher',
            onClose: () => {},
          }),
        ),
      ),
    );
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

describe('ToolDetailModal — the mismatch alert', () => {
  it('warns when the toolset lists a tool this deployment never registered', async () => {
    detailFn.mockResolvedValue(
      baseDetail({
        name: 'ghost_tool',
        description: '',
        toolset: undefined,
        group: 'Other',
        schema: {},
        capabilities: {},
        registered: false,
        available: false,
        inPersonalityToolset: true,
        testEligibility: { canRun: false, reason: 'Tool is not registered.' },
      }),
    );
    await mountModal('ghost_tool');

    expect(document.body.textContent).toContain(
      'This personality lists a tool this deployment does not have',
    );
    expect(document.body.textContent).toContain('silently cannot call it');
    expect(document.body.textContent).toContain('Not registered');
  });

  it('warns when a registered tool reports itself unavailable', async () => {
    detailFn.mockResolvedValue(baseDetail({ available: false }));
    await mountModal();

    expect(document.body.textContent).toContain('Registered, but unavailable in this deployment');
    expect(document.body.textContent).not.toContain(
      'This personality lists a tool this deployment does not have',
    );
  });

  it('shows neither alert for a healthy tool', async () => {
    await mountModal();

    expect(document.body.textContent).not.toContain(
      'This personality lists a tool this deployment does not have',
    );
    expect(document.body.textContent).not.toContain(
      'Registered, but unavailable in this deployment',
    );
    expect(document.body.textContent).toContain('Reads a file from disk.');
  });
});

describe('ToolDetailModal — the test button', () => {
  it('reads "Verify" and names the reason when the server will not run it', async () => {
    detailFn.mockResolvedValue(
      baseDetail({
        name: 'write_file',
        testEligibility: {
          canRun: false,
          reason: 'Tool declares filesystem write reach.',
        },
      }),
    );
    await mountModal('write_file');

    expect(buttonByText('Verify')).toBeDefined();
    expect(document.body.textContent).toContain('Tool declares filesystem write reach.');
    expect(document.body.textContent).not.toContain('Test — runs the tool');
  });

  it('says the tool will really run when the server says it may', async () => {
    await mountModal();
    expect(buttonByText('Test — runs the tool')).toBeDefined();
  });

  it('does not fire the test on mount, and always asks for mode "run"', async () => {
    testFn.mockResolvedValue({
      checks: [
        { id: 'registered', label: 'Registered', status: 'pass' },
        { id: 'available', label: 'Available', status: 'pass' },
        { id: 'in-toolset', label: 'In personality toolset', status: 'pass' },
        { id: 'args-valid', label: 'Sample arguments valid', status: 'pass' },
      ],
      ran: false,
      testEligibility: { canRun: true },
    });
    await mountModal();

    expect(testFn).not.toHaveBeenCalled();

    await click(buttonByText('Test — runs the tool'));

    expect(testFn).toHaveBeenCalledTimes(1);
    expect(testFn).toHaveBeenCalledWith({
      name: 'read_file',
      personalityId: 'researcher',
      mode: 'run',
    });
  });

  // `mode: 'run'` is a request, not a grant — an ineligible tool still gets
  // sent, and the server degrades it. The UI must show that honestly.
  it('sends mode "run" even for a tool the server will refuse to execute', async () => {
    detailFn.mockResolvedValue(
      baseDetail({
        testEligibility: { canRun: false, reason: 'Tool requires approval before every call.' },
      }),
    );
    testFn.mockResolvedValue({
      checks: [
        { id: 'registered', label: 'Registered', status: 'pass' },
        { id: 'available', label: 'Available', status: 'pass' },
        { id: 'in-toolset', label: 'In personality toolset', status: 'pass' },
        { id: 'args-valid', label: 'Sample arguments valid', status: 'pass', detail: '{"a":1}' },
      ],
      ran: false,
      testEligibility: { canRun: false, reason: 'Tool requires approval before every call.' },
    });
    await mountModal();

    await click(buttonByText('Verify'));

    expect(testFn).toHaveBeenCalledWith({
      name: 'read_file',
      personalityId: 'researcher',
      mode: 'run',
    });
    expect(document.body.textContent).toContain(
      'Not executed — Tool requires approval before every call.',
    );
  });
});

describe('ToolDetailModal — results', () => {
  it('renders the four checks and the execution output when the tool ran', async () => {
    testFn.mockResolvedValue({
      checks: [
        { id: 'registered', label: 'Registered', status: 'pass' },
        { id: 'available', label: 'Available', status: 'pass' },
        { id: 'in-toolset', label: 'In personality toolset', status: 'pass' },
        {
          id: 'args-valid',
          label: 'Sample arguments valid',
          status: 'pass',
          detail: '{"path":"example"}',
        },
      ],
      ran: true,
      result: { ok: true, value: 'file contents here' },
      durationMs: 42,
      testEligibility: { canRun: true },
    });
    await mountModal();
    await click(buttonByText('Test — runs the tool'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Registered');
    expect(text).toContain('Available');
    expect(text).toContain('In personality toolset');
    expect(text).toContain('Sample arguments valid');
    expect(text).toContain('{"path":"example"}');
    expect(text).toContain('Ran — ok');
    expect(text).toContain('42ms');
    expect(text).toContain('file contents here');
  });

  it('renders a failed execution with its error and code', async () => {
    testFn.mockResolvedValue({
      checks: [
        { id: 'registered', label: 'Registered', status: 'pass' },
        { id: 'available', label: 'Available', status: 'pass' },
        { id: 'in-toolset', label: 'In personality toolset', status: 'pass' },
        { id: 'args-valid', label: 'Sample arguments valid', status: 'pass', detail: '{}' },
      ],
      ran: true,
      result: { ok: false, error: 'ENOENT: no such file', code: 'not_found' },
      durationMs: 3,
      testEligibility: { canRun: true },
    });
    await mountModal();
    await click(buttonByText('Test — runs the tool'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Ran — failed');
    expect(text).toContain('not_found');
    expect(text).toContain('ENOENT: no such file');
  });

  it('reports a downstream skip without claiming a run', async () => {
    testFn.mockResolvedValue({
      checks: [
        {
          id: 'registered',
          label: 'Registered',
          status: 'fail',
          detail: 'No tool named "read_file" is registered.',
        },
        { id: 'available', label: 'Available', status: 'skip' },
        { id: 'in-toolset', label: 'In personality toolset', status: 'skip' },
        { id: 'args-valid', label: 'Sample arguments valid', status: 'skip' },
      ],
      ran: false,
      testEligibility: { canRun: false, reason: 'Tool is not registered.' },
    });
    await mountModal();
    await click(buttonByText('Test — runs the tool'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('No tool named "read_file" is registered.');
    expect(text).toContain('Not executed — Tool is not registered.');
    expect(text).not.toContain('Ran — ok');
  });
});

describe('ToolDetailModal — capabilities and schema', () => {
  it("explains 'from-personality' rather than printing the sentinel", async () => {
    await mountModal();
    const text = document.body.textContent ?? '';
    expect(text).toContain("Inherits this personality's reach");
    expect(text).not.toContain('from-personality');
  });

  it('renders declared capabilities and omits the keys that are absent', async () => {
    detailFn.mockResolvedValue(
      baseDetail({
        capabilities: {
          network: { allowedHosts: ['api.example.com'] },
          secrets: ['EXAMPLE_API_KEY'],
          storage: { scope: 'tool-private', kind: 'kv', ttlSecondsDefault: 3600 },
          process: { allowedBinaries: ['rg'] },
          attachments: { kinds: '*' },
        },
        maxResultChars: 20000,
        outputIsUntrusted: true,
        hasSettingsSchema: true,
      }),
    );
    await mountModal();

    const text = document.body.textContent ?? '';
    expect(text).toContain('api.example.com');
    expect(text).toContain('EXAMPLE_API_KEY');
    expect(text).toContain('tool-private · kv · ttl 3600s');
    expect(text).toContain('rg');
    expect(text).toContain('Any kind');
    expect(text).toContain('20,000 chars');
    expect(text).toContain('Treated as untrusted input');
    expect(text).toContain('Tool settings');
    expect(text).not.toContain('Writes');
    expect(text).not.toContain('Approval');
  });

  it('says so plainly when a tool declares nothing and has no schema', async () => {
    detailFn.mockResolvedValue(baseDetail({ capabilities: {}, schema: {} }));
    await mountModal();

    expect(document.body.textContent).toContain('Declares no capabilities.');
    expect(document.body.textContent).toContain('No schema.');
  });
});
