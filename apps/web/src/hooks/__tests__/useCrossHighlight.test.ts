// @vitest-environment jsdom
//
// teams-as-a-scope T4 — cross-highlight (D12): one delegated hover pair on
// the shell root toggles `is-hl-on` on the root and `is-hl` on every element
// sharing the hovered `data-p`; leaving clears; nothing happens outside a
// team, and deactivating mid-hover clears too.

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCrossHighlight } from '../useCrossHighlight';

function Shell({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useCrossHighlight(ref, active);
  return createElement(
    'div',
    { ref, className: 'app-shell' },
    createElement(
      'span',
      { 'data-p': 'cmo', id: 'tile' },
      createElement('span', { id: 'tile-child' }, 'cmo'),
    ),
    createElement('span', { 'data-p': 'reddit-scout', id: 'scout' }),
    createElement('span', { 'data-p': 'cmo', id: 'ledger' }),
    createElement('span', { id: 'plain' }),
  );
}

let container: HTMLDivElement;
let root: Root;

async function mount(active: boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(Shell, { active }));
  });
}

const el = (id: string) => {
  const found = container.querySelector(`#${id}`);
  if (!found) throw new Error(`missing #${id}`);
  return found;
};
const shell = () => el('tile').parentElement as HTMLElement;
const fire = (target: Element, type: 'mouseover' | 'mouseout', relatedTarget: Element | null) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
  });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('useCrossHighlight', () => {
  it('lights every carrier of the hovered id and dims the rest', async () => {
    await mount(true);
    await fire(el('tile-child'), 'mouseover', null);
    expect(shell().classList.contains('is-hl-on')).toBe(true);
    expect(el('tile').classList.contains('is-hl')).toBe(true);
    expect(el('ledger').classList.contains('is-hl')).toBe(true);
    expect(el('scout').classList.contains('is-hl')).toBe(false);
  });

  it('moving within the same carrier keeps the highlight; leaving clears it', async () => {
    await mount(true);
    await fire(el('tile'), 'mouseover', null);
    await fire(el('tile'), 'mouseout', el('tile-child'));
    expect(shell().classList.contains('is-hl-on')).toBe(true);

    await fire(el('tile'), 'mouseout', el('plain'));
    expect(shell().classList.contains('is-hl-on')).toBe(false);
    expect(container.querySelectorAll('.is-hl')).toHaveLength(0);
  });

  it('hovering something without data-p does nothing', async () => {
    await mount(true);
    await fire(el('plain'), 'mouseover', null);
    expect(shell().classList.contains('is-hl-on')).toBe(false);
  });

  it('is inert outside a team', async () => {
    await mount(false);
    await fire(el('tile'), 'mouseover', null);
    expect(shell().classList.contains('is-hl-on')).toBe(false);
    expect(container.querySelectorAll('.is-hl')).toHaveLength(0);
  });

  it('deactivating clears a live highlight', async () => {
    await mount(true);
    await fire(el('tile'), 'mouseover', null);
    expect(shell().classList.contains('is-hl-on')).toBe(true);
    await mount(false);
    expect(shell().classList.contains('is-hl-on')).toBe(false);
    expect(container.querySelectorAll('.is-hl')).toHaveLength(0);
  });
});
