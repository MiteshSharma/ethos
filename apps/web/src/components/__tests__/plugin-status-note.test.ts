// @vitest-environment jsdom
//
// A plugin row only speaks up when it has something to say. Two states earn
// chrome: a plugin that failed to load (invisible in the web UI until now) and
// a plugin that loaded carrying yellow safety notes — the trade for no longer
// refusing it. A clean plugin renders nothing.
//
// Same jsdom + `react-dom/client` harness as `tab-save-bar.test.ts`: no
// testing-library in this repo, and Antd's Modal portals into `document.body`.

import type { PluginInfo } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const { PluginStatusNote } = await import('../PluginStatusNote');

const BASE: PluginInfo = {
  id: 'tools-nse-market-data',
  name: '@ethosagent/tools-nse-market-data',
  version: '0.1.34',
  description: 'NSE India market data',
  source: 'npm',
  path: '/home/u/.ethos/plugins/node_modules/@ethosagent/tools-nse-market-data',
  pluginContractMajor: 2,
  status: 'loaded',
  error: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(plugin: PluginInfo): void {
  act(() => {
    root.render(createElement(PluginStatusNote, { plugin }));
  });
}

describe('PluginStatusNote', () => {
  it('renders nothing for a plugin that loaded cleanly', () => {
    render(BASE);
    expect(container.textContent).toBe('');
  });

  it('shows the reason a plugin failed to load', () => {
    render({
      ...BASE,
      status: 'failed',
      error: 'Blocked by safety scan: red findings (pass --force to override)',
    });
    expect(container.textContent).toContain('Not loaded');
    expect(container.textContent).toContain('red findings');
  });

  it('offers the yellow notes, and explains the rule in plain language', () => {
    render({
      ...BASE,
      scanFindings: [
        {
          severity: 'yellow',
          rule: 'network-access',
          message: 'Network call to dynamic URL — cannot verify against declared hosts',
          file: 'dist/index.js',
          line: 412,
          excerpt: 'const res = await fetch(url, init);',
        },
      ],
    });

    const button = container.querySelector('button');
    expect(button?.textContent).toContain('1 safety note');
    expect(button?.textContent).toContain('Loaded');

    act(() => {
      button?.click();
    });

    const body = document.body.textContent ?? '';
    expect(body).toContain('Makes outbound network calls');
    expect(body).toContain('cannot verify against declared hosts');
    expect(body).toContain('dist/index.js:412');
    expect(body).toContain('await fetch(url, init)');
    expect(body).toContain('non-blocking');
  });
});
