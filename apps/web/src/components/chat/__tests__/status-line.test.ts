// @vitest-environment jsdom
//
// The status line is the promise that every request is acknowledged within the
// first second and never leaves the user guessing (feedback & activity contract
// §2). These cases assert the four things that promise rests on: the phase
// words, the reserved slot it shares with the trail footer, the 20 s stall
// notice, and a live region that does not machine-gun a screen reader.
//
// Same jsdom + `react-dom/client` harness as `tab-save-bar.test.ts` — the repo
// has no testing-library.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_THROTTLE_MS, StatusLine, type StatusLineProps } from '../StatusLine';
import { Trail } from '../Trail';

function markup(props: Partial<StatusLineProps> = {}): string {
  return renderToStaticMarkup(
    createElement(StatusLine, {
      phase: 'thinking',
      label: null,
      elapsedMs: 0,
      stalled: false,
      ...props,
    }),
  );
}

describe('StatusLine — the words are the feedback', () => {
  it('names each phase in plain language', () => {
    expect(markup({ phase: 'received' })).toContain('received');
    expect(markup({ phase: 'thinking' })).toContain('thinking');
    expect(markup({ phase: 'writing' })).toContain('writing');
  });

  it('shows the running tool and its args instead of a generic word', () => {
    const html = markup({ phase: 'tool', label: 'read_file · /etc/hosts' });
    expect(html).toContain('read_file · /etc/hosts');
    expect(html).not.toContain('>working<');
  });

  it('draws nothing at all when no turn is in flight', () => {
    expect(markup({ phase: null })).toBe('');
  });

  it('shows elapsed time once there is any, and nothing before', () => {
    expect(markup({ elapsedMs: 12_400 })).toContain('12.4s');
    expect(markup({ elapsedMs: 0 })).not.toContain('s<');
  });
});

describe('StatusLine — the reserved slot', () => {
  it('occupies the SAME slot class the trail footer takes over', () => {
    // One class, one height: the handover from status line to footer is what
    // makes "nothing moves" true rather than aspirational.
    expect(markup()).toContain('activity-slot');
    const footer = renderToStaticMarkup(
      createElement(Trail, {
        turnId: 't1',
        entries: [
          { kind: 'action', toolCallId: 'tc1', toolName: 'x', args: {}, status: 'ok' as const },
        ],
      }),
    );
    expect(footer).toContain('activity-slot');
  });

  it('pulses the dot only while a tool is running', () => {
    expect(markup({ phase: 'tool', label: 'bash' })).toContain('sb-dot--pulse');
    expect(markup({ phase: 'thinking' })).not.toContain('sb-dot--pulse');
    expect(markup({ phase: 'received' })).not.toContain('sb-dot--pulse');
  });
});

describe('StatusLine — stall', () => {
  it('appends glyph AND word after 20 s of silence', () => {
    const html = markup({ stalled: true });
    expect(html).toContain('⚠ still working');
    expect(html).toContain('status-line-stall');
  });

  it('says nothing extra while events are still arriving', () => {
    expect(markup({ stalled: false })).not.toContain('still working');
  });
});

describe('StatusLine — the live region', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(props: Partial<StatusLineProps>) {
    act(() => {
      root.render(
        createElement(StatusLine, {
          phase: 'received',
          label: null,
          elapsedMs: 0,
          stalled: false,
          ...props,
        }),
      );
    });
  }

  function region(): HTMLElement | null {
    return container.querySelector('[role="status"]');
  }

  it('is a polite status region', () => {
    render({});
    expect(region()?.getAttribute('aria-live')).toBe('polite');
  });

  it('announces the send immediately', () => {
    render({});
    expect(region()?.textContent).toBe('received');
  });

  it('throttles to one announcement per 2 s, and lands the latest state', () => {
    render({});
    expect(region()?.textContent).toBe('received');

    // Three tool changes inside the window: the region must not narrate all of
    // them, and must not get stuck on the first either.
    render({ phase: 'tool', label: 'read_file' });
    render({ phase: 'tool', label: 'bash' });
    render({ phase: 'tool', label: 'web_fetch' });
    expect(region()?.textContent).toBe('received');

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_THROTTLE_MS);
    });
    expect(region()?.textContent).toBe('web_fetch');
  });

  it('never throttles the acknowledgement that a NEW turn was received', () => {
    // The contract promises the send is acknowledged inside the first second.
    // A shared, session-long throttle broke that: a question asked within 2 s
    // of the previous announcement had its `received` deferred behind it.
    render({ phase: 'received' });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_THROTTLE_MS);
    });
    render({ phase: 'tool', label: 'bash' });
    expect(region()?.textContent).toBe('bash');

    // Turn ends, next question goes in immediately.
    render({ phase: null });
    render({ phase: 'received' });
    expect(region()?.textContent).toBe('received');
  });

  it('leaves the VISIBLE line unthrottled — the eye is not made to wait', () => {
    render({});
    render({ phase: 'tool', label: 'read_file' });
    expect(container.querySelector('.status-line-label')?.textContent).toBe('read_file');
  });
});
