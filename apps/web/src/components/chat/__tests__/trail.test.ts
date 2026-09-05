// @vitest-environment jsdom
//
// The trail footer is the account of what the agent did, in the slot the
// status line vacated (feedback & activity contract §3/§5). These cases pin
// the four claims that make it trustworthy: it counts honestly, it says
// nothing when there is nothing to say, it never fabricates assurance, and a
// finding takes you to the evidence it cites.

import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAction, applyEvent, initialChatState } from '../../../lib/chat-reducer';
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

  it('draws NO footer at all when the turn did nothing and found nothing', () => {
    expect(markup([])).toBe('');
  });

  it('draws a footer for a turn with findings and NO actions', () => {
    // The `no_tools_at_all` finding — the agent claimed work it never did — has
    // zero actions BY DEFINITION, so the older "zero actions → no footer" rule
    // silenced the exact case the whole feature exists to surface. The rule it
    // replaces is unchanged for a turn with neither (the test above).
    const html = markup([
      { kind: 'finding', id: 'f1', claim: 'I ran the tests', evidence: 'no tool ran this turn' },
    ]);
    expect(text(html)).toContain('⚠ 1 unverified');
    // No count and no duration: `0 actions · —` is two pieces of noise around
    // the one thing worth reading.
    expect(html).not.toContain('actions');
    expect(html).not.toContain('—');
    // And still no assurance glyph — a finding is the opposite of a tick.
    expect(html).not.toContain('✓');
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

  it('withholds the ✓ while an action is still running', () => {
    // A `tool_end` that never arrives — a dropped SSE frame, a server that died
    // mid-turn. The reducers deliberately leave the row `running` at `done`
    // (a late `tool_end` is legitimate and must not be slandered as a failure),
    // so the footer is what has to stay honest: `2 actions`, no tick.
    const html = markup([
      action({ toolCallId: 'a', status: 'ok' }),
      action({ toolCallId: 'b', status: 'running', durationMs: undefined }),
    ]);
    expect(text(html)).toContain('2 actions');
    expect(html).not.toContain('✓');
  });

  it('withholds the ✓ while an action is parked on an approval', () => {
    const html = markup([
      action({ toolCallId: 'a', status: 'ok' }),
      action({ toolCallId: 'b', status: 'pending-approval', durationMs: undefined }),
    ]);
    expect(text(html)).toContain('2 actions');
    expect(html).not.toContain('✓');
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

  it('draws the claim quoted and the evidence beside it', () => {
    render([
      action({ toolCallId: 'tc9', toolName: 'bash' }),
      {
        kind: 'finding',
        id: 'f1',
        claim: 'tests pass',
        evidence: 'run_tests exited 1',
        citesToolCallId: 'tc9',
      },
    ]);
    act(() => footer().click());
    const finding = container.querySelector('.activity-row-unverified');
    expect(finding?.textContent).toContain('⚠ unverified');
    expect(finding?.textContent).toContain('"tests pass"');
    expect(finding?.textContent).toContain('run_tests exited 1');
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

  it('a finding citing nothing is an inert row — clicking it moves no focus', () => {
    // History replay drops the cited call: the finding still has to render,
    // and the row must not steal focus to somewhere arbitrary.
    render([{ kind: 'finding', id: 'f1', claim: 'tests pass', evidence: 'no test command ran' }]);
    act(() => footer().click());
    const finding = container.querySelector<HTMLButtonElement>('.activity-row-unverified');
    expect(finding).not.toBeNull();
    const before = document.activeElement;
    act(() => finding?.click());
    expect(document.activeElement).toBe(before);
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

// End to end from the LIVE stream: a `tool_start` whose `tool_end` never comes,
// then `done`. This is the defect the `unsettled` count closes — the row reads
// `· running` for ever, and the footer used to lead `✓ 1 action` over it.
describe('Trail footer — fed by a turn whose tool never reported back', () => {
  /** The footer of the turn `done` just moved into history. */
  function liveFooter(events: SseEvent[]): string {
    let state = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'go',
      timestamp: 1,
    });
    let turnId = '';
    for (const event of events) {
      state = applyEvent(state, event, 1_000);
      turnId = state.currentTurn?.id ?? turnId;
    }
    return renderToStaticMarkup(
      createElement(Trail, { entries: state.trail[turnId] ?? [], turnId }),
    );
  }

  /** One call that came back ok, one whose `tool_end` never did. */
  const oneOkOneLost: SseEvent[] = [
    { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: { path: '/x' } },
    { type: 'tool_end', toolCallId: 'tc1', toolName: 'read_file', ok: true, durationMs: 40 },
    { type: 'tool_start', toolCallId: 'tc2', toolName: 'bash', args: { command: 'ls' } },
  ];

  it('leads with the bare count, never a ✓, when a tool_end never arrived', () => {
    // The genuine defect: one call DID come back ok, so the footer used to
    // lead `✓ 2 actions` over a row that still reads `· running` for ever.
    const html = liveFooter([...oneOkOneLost, { type: 'done', text: 'done', turnCount: 1 }]);
    // The exact lead: the count, and no assurance glyph at all.
    expect(text(html)).toContain('2 actions · 40ms');
    expect(html).not.toContain('✓');
    expect(html).not.toContain('✗');
  });

  it('leads with ✓ once the late tool_end lands', () => {
    // The other half of the same rule: withholding the tick is not a verdict,
    // it is the absence of one, and it is revoked the moment the call reports —
    // which is why `done` must not paint a ✗ on the row in the first place.
    const html = liveFooter([
      ...oneOkOneLost,
      { type: 'done', text: 'done', turnCount: 1 },
      { type: 'tool_end', toolCallId: 'tc2', toolName: 'bash', ok: true, durationMs: 8 },
    ]);
    expect(text(html)).toContain('✓ 2 actions');
  });
});

// End to end: the persisted `isError` flag reaches the footer's lead glyph.
// The rule it must not weaken — a ✓ needs at least one genuine success and
// nothing unrecorded — is `Trail`'s, not this test's; this pins that the flag
// is what now feeds it (contract §3).
describe('Trail footer — fed by reloaded history', () => {
  function storedMsg(
    over: Partial<StoredMessage> & { role: StoredMessage['role'] },
  ): StoredMessage {
    return {
      id: 'm',
      sessionId: 's1',
      content: '',
      toolCallId: null,
      toolName: null,
      toolCalls: null,
      timestamp: new Date(0).toISOString(),
      ...over,
    };
  }

  /** One assistant turn calling `read_file`, plus its `tool_result` row. */
  function reloadedFooter(isError: boolean | undefined): string {
    const state = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: [
        storedMsg({
          id: 'a1',
          role: 'assistant',
          content: 'one',
          toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'x' } }],
          timestamp: new Date(10).toISOString(),
        }),
        storedMsg({
          id: 'r1',
          role: 'tool_result',
          content: 'body',
          toolCallId: 'tc1',
          toolName: 'read_file',
          ...(isError === undefined ? {} : { isError }),
          timestamp: new Date(11).toISOString(),
        }),
      ],
    });
    return renderToStaticMarkup(
      createElement(Trail, { entries: state.trail.a1 ?? [], turnId: 'a1' }),
    );
  }

  it('leads with ✓ when history recorded a success', () => {
    const html = reloadedFooter(false);
    expect(text(html)).toContain('✓ 1 action');
  });

  it('leads with ✗ when history recorded a failure', () => {
    const html = reloadedFooter(true);
    expect(text(html)).toContain('✗ 1 action');
    expect(html).not.toContain('✓');
  });

  it('leads with NO glyph when history recorded nothing (pre-migration row)', () => {
    const html = reloadedFooter(undefined);
    expect(text(html)).toContain('1 action');
    expect(html).not.toContain('✓');
    expect(html).not.toContain('✗');
  });
});
