// @vitest-environment jsdom
//
// The trail footer is the account of what the agent did, in the slot the
// status line vacated (feedback & activity contract §3/§5). These cases pin
// the four claims that make it trustworthy: it counts honestly, it says
// nothing when there is nothing to say, it never fabricates assurance, and a
// finding takes you to the evidence it cites.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrailAction, TrailEntry } from '../../../lib/trail';
import { Trail } from '../Trail';

function action(over: Partial<TrailAction> = {}): TrailAction {
  return {
    kind: 'action',
    toolCallId: 'tc1',
    toolName: 'read_file',
    args: { path: '/etc/hosts' },
    status: 'ok',
    durationMs: 1_200,
    ...over,
  };
}

/** The footer's visible text, tags stripped — the lead and the duration are
 *  separate spans, so `4 actions · —` only reads as one line once they are. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function markup(entries: TrailEntry[], stopped?: boolean): string {
  return renderToStaticMarkup(
    createElement(Trail, { entries, turnId: 't1', ...(stopped ? { stopped } : {}) }),
  );
}

describe('Trail footer — the count', () => {
  it('reads `✓ N actions · <duration>`', () => {
    const html = markup([
      action({ toolCallId: 'a' }),
      action({ toolCallId: 'b', durationMs: 300 }),
    ]);
    expect(html).toContain('✓ 2 actions');
    expect(html).toContain('1.5s');
  });

  it('counts findings separately, as unverified', () => {
    const html = markup([
      action(),
      { kind: 'finding', id: 'f1', claim: 'tests pass' },
      { kind: 'finding', id: 'f2', claim: 'no regressions' },
    ]);
    expect(html).toContain('✓ 1 action');
    expect(html).toContain('⚠ 2 unverified');
  });

  it('leads with ✗ when any action failed — a failure is not a tick', () => {
    expect(markup([action({ status: 'failed' })])).toContain('✗ 1 action');
  });

  it('reads `✗ stopped · N actions` for a turn the user stopped', () => {
    expect(markup([action(), action({ toolCallId: 'b' })], true)).toContain(
      '✗ stopped · 2 actions',
    );
  });

  it('renders `—` when history carries no durations', () => {
    const html = markup([action({ durationMs: undefined })]);
    expect(html).toContain('—');
  });

  it('draws NO footer at all when the turn took no actions', () => {
    expect(markup([])).toBe('');
    // A finding with no action behind it is still not an account of work.
    expect(markup([{ kind: 'finding', id: 'f1', claim: 'x' }])).toBe('');
  });

  it('never claims "verified" — zero findings means nothing was checked', () => {
    const html = markup([action()]);
    expect(html).not.toContain('verified');
  });

  it('leads with NO glyph when every action came back from history unrecorded', () => {
    // A reloaded turn: the wire carries no ok/failed flag, so a ✓ here would be
    // assurance nothing ever gave. `4 actions · —` is the honest line.
    const html = markup([
      action({ toolCallId: 'a', status: 'unrecorded', durationMs: undefined }),
      action({ toolCallId: 'b', status: 'unrecorded', durationMs: undefined }),
      action({ toolCallId: 'c', status: 'unrecorded', durationMs: undefined }),
      action({ toolCallId: 'd', status: 'unrecorded', durationMs: undefined }),
    ]);
    expect(text(html)).toContain('4 actions · —');
    expect(html).not.toContain('✓');
  });

  it('withholds the ✓ as soon as ONE action is unrecorded', () => {
    const html = markup([
      action({ toolCallId: 'a', status: 'ok' }),
      action({ toolCallId: 'b', status: 'unrecorded', durationMs: undefined }),
    ]);
    expect(html).not.toContain('✓');
    expect(text(html)).toContain('2 actions');
  });

  it('still leads with ✗ when an unrecorded turn also holds a failure', () => {
    const html = markup([
      action({ toolCallId: 'a', status: 'unrecorded', durationMs: undefined }),
      action({ toolCallId: 'b', status: 'failed' }),
    ]);
    expect(text(html)).toContain('✗ 2 actions');
  });
});

describe('Trail — expansion', () => {
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
  });

  function render(entries: TrailEntry[]) {
    act(() => {
      root.render(createElement(Trail, { entries, turnId: 't1' }));
    });
  }

  function footer(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>('.trail-footer');
    if (!el) throw new Error('no footer');
    return el;
  }

  it('starts collapsed and toggles aria-expanded with the rows', () => {
    render([action()]);
    expect(footer().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.trail-row')).toHaveLength(0);

    act(() => footer().click());
    expect(footer().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.trail-row')).toHaveLength(1);

    act(() => footer().click());
    expect(footer().getAttribute('aria-expanded')).toBe('false');
  });

  it('gives each row a glyph AND a word, never colour alone', () => {
    render([
      action({ toolCallId: 'a', status: 'ok' }),
      action({ toolCallId: 'b', status: 'failed' }),
    ]);
    act(() => footer().click());
    const states = Array.from(container.querySelectorAll('.activity-row-state')).map(
      (el) => el.textContent,
    );
    expect(states).toEqual(['✓ ok', '✗ failed']);
  });

  it('a finding row moves focus to the action row it cites', () => {
    render([
      action({ toolCallId: 'tc9', toolName: 'bash' }),
      {
        kind: 'finding',
        id: 'f1',
        claim: 'tests pass',
        evidence: 'no test command ran',
        citesToolCallId: 'tc9',
      },
    ]);
    act(() => footer().click());

    const finding = container.querySelector<HTMLButtonElement>('.activity-row-unverified');
    const cited = container.querySelector<HTMLButtonElement>('#trail-row-t1-tc9');
    expect(finding).not.toBeNull();
    expect(cited).not.toBeNull();
    expect(document.activeElement).not.toBe(cited);

    act(() => finding?.click());
    expect(document.activeElement).toBe(cited);
  });

  it('shows the args and the result once a row is opened', () => {
    render([action({ result: 'root 127.0.0.1' })]);
    act(() => footer().click());
    const row = container.querySelector<HTMLButtonElement>('.trail-row');
    act(() => row?.click());
    expect(container.textContent).toContain('/etc/hosts');
    expect(container.textContent).toContain('root 127.0.0.1');
  });
});
