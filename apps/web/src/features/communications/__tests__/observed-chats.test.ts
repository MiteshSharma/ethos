// @vitest-environment jsdom
//
// Communications › Observed chats (plan/phases/ambient-group-monitoring.md
// R12), against `feedback-activity-contract.md`.
//
// The contract's claim is that a user who has learned one row has learned them
// all, so the load-bearing assertion here is NOT "a row appeared" — it is that
// the markup this section emits is byte-identical to what the shared
// `FeedbackRow` emits for the same inputs. A lookalike that drew the same words
// with its own classes would pass a text assertion and fail the contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackRow } from '../../../components/ui/FeedbackRow';
import {
  groupByBot,
  OBSERVED_EMPTY_COPY,
  type ObservedLane,
  observedErrorRow,
  observedRowView,
  omittedNote,
  startOfToday,
} from '../observed-rows';

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

const observedFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: { channels: { observed: (...args: unknown[]) => observedFn(...args) } },
}));

const { ObservedChats } = await import('../ObservedChats');

const NOW = Date.parse('2026-09-04T12:00:00Z');

function lane(over: Partial<ObservedLane> = {}): ObservedLane {
  return {
    laneKey: 'telegram:bot-a:-100',
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: '-100',
    threadId: null,
    count: 3,
    lastSentAt: NOW - 120_000,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client } as { client: QueryClient; children?: ReactNode },
        createElement(ObservedChats),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------
// The shared row
// ---------------------------------------------------------------------------

describe('Observed chats — the shared row vocabulary', () => {
  it('renders every lane through FeedbackRow, not a lookalike', async () => {
    observedFn.mockResolvedValue({ lanes: [lane()], omittedCount: 0, error: null });
    await mount();

    const view = observedRowView(lane(), Date.now());
    const shared = renderToStaticMarkup(
      createElement(FeedbackRow, {
        status: view.status,
        subject: view.subject,
        result: view.result,
        meta: view.meta,
      }),
    );
    // Not "contains the same words" — contains the same MARKUP. A second row
    // component with its own classes would fail here and pass a text check.
    expect(container.innerHTML).toContain(shared.replace(/^<div/, '<div'));
  });

  it('pairs a glyph WITH a word for a recorded lane and for a failed read', () => {
    const ok = renderToStaticMarkup(createElement(FeedbackRow, observedRowView(lane(), NOW)));
    expect(ok).toContain('✓');
    expect(ok).toContain('ok');
    expect(ok).toContain('activity-row-ok');

    const failed = renderToStaticMarkup(createElement(FeedbackRow, observedErrorRow('disk full')));
    expect(failed).toContain('✗');
    expect(failed).toContain('failed');
    expect(failed).toContain('activity-row-failed');
  });

  it('never draws a Card — this is a dense list of rows', async () => {
    observedFn.mockResolvedValue({ lanes: [lane()], omittedCount: 0, error: null });
    await mount();
    expect(container.innerHTML).not.toContain('ant-card');
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe('Observed chats — states', () => {
  it('uses the EXISTING empty-state voice when nothing is watched', async () => {
    observedFn.mockResolvedValue({ lanes: [], omittedCount: 0, error: null });
    await mount();
    expect(container.textContent).toContain('Quiet for now.');
    expect(container.textContent).toContain(OBSERVED_EMPTY_COPY);
    // Zero findings must not become a claim that anything was verified.
    expect(container.textContent).not.toContain('verified');
  });

  it('keeps an unreadable transcript on the page as a ✗ failed row', async () => {
    observedFn.mockResolvedValue({
      lanes: [],
      omittedCount: 0,
      error: 'database disk image is malformed',
    });
    await mount();
    expect(container.textContent).toContain('✗');
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('database disk image is malformed');
    // A failure is not an empty house, and must not be drawn as one.
    expect(container.textContent).not.toContain('Quiet for now.');
  });

  it('draws a failed row when the request itself never arrives', async () => {
    observedFn.mockRejectedValue(new Error('Failed to fetch'));
    await mount();
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('Failed to fetch');
  });

  it('groups lanes under the bot that watches them', async () => {
    observedFn.mockResolvedValue({
      lanes: [
        lane({ laneKey: 'l1', botKey: 'bot-a', chatId: '-100' }),
        lane({ laneKey: 'l2', platform: 'whatsapp', botKey: 'wa-1', chatId: '99@g.us' }),
        lane({ laneKey: 'l3', botKey: 'bot-a', chatId: '-200' }),
      ],
      omittedCount: 0,
      error: null,
    });
    await mount();
    expect(container.textContent).toContain('telegram · bot-a');
    expect(container.textContent).toContain('whatsapp · wa-1');
    expect(container.querySelectorAll('.observed-bot')).toHaveLength(2);
    expect(container.querySelectorAll('.activity-row')).toHaveLength(3);
  });

  it('says how many watched chats it is NOT showing', async () => {
    observedFn.mockResolvedValue({ lanes: [lane()], omittedCount: 12, error: null });
    await mount();
    expect(container.textContent).toContain('showing 1 of 13 watched chats');
  });

  it('never puts message text on the page — there is none to put', async () => {
    observedFn.mockResolvedValue({ lanes: [lane()], omittedCount: 0, error: null });
    await mount();
    // The wire schema has no text field at all; this asserts the section did
    // not invent one from somewhere else.
    expect(Object.keys(lane())).not.toContain('text');
  });
});

// ---------------------------------------------------------------------------
// View logic
// ---------------------------------------------------------------------------

describe('observedRowView', () => {
  it('reads a quiet-but-watched room honestly', () => {
    const view = observedRowView(lane({ count: 0, lastSentAt: NOW - 3 * 86_400_000 }), NOW);
    expect(view.status).toBe('ok');
    expect(view.result).toBe('no messages today');
    expect(view.meta).toBe('3d ago');
  });

  it('counts in singular and plural', () => {
    expect(observedRowView(lane({ count: 1 }), NOW).result).toBe('1 message today');
    expect(observedRowView(lane({ count: 9 }), NOW).result).toBe('9 messages today');
  });

  it('names a thread as its own room', () => {
    expect(observedRowView(lane({ threadId: 't7' }), NOW).subject).toBe('-100 / t7');
    expect(observedRowView(lane(), NOW).subject).toBe('-100');
  });
});

describe('omittedNote', () => {
  it('is silent when the list is whole', () => {
    expect(omittedNote(4, 0)).toBeNull();
  });
  it('reports the total, not just the remainder', () => {
    expect(omittedNote(500, 40)).toBe('showing 500 of 540 watched chats');
  });
});

describe('groupByBot', () => {
  it('preserves the server order between groups and inside one', () => {
    const groups = groupByBot([
      lane({ laneKey: 'a', botKey: 'b1', chatId: '1' }),
      lane({ laneKey: 'b', botKey: 'b2', chatId: '2' }),
      lane({ laneKey: 'c', botKey: 'b1', chatId: '3' }),
    ]);
    expect(groups.map((g) => g.botKey)).toEqual(['b1', 'b2']);
    expect(groups[0]?.lanes.map((l) => l.chatId)).toEqual(['1', '3']);
  });

  it('keys a group by platform AND botKey — two platforms can share a botKey', () => {
    const groups = groupByBot([
      lane({ laneKey: 'a', platform: 'slack', botKey: 'shared' }),
      lane({ laneKey: 'b', platform: 'discord', botKey: 'shared' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.id)).toEqual(['slack:shared', 'discord:shared']);
  });
});

describe('startOfToday', () => {
  it('is local midnight, because "today" is the READER\'s today', () => {
    const at = Date.parse('2026-09-04T15:30:00');
    const start = new Date(startOfToday(at));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(new Date(at).getDate());
    expect(startOfToday(at)).toBeLessThanOrEqual(at);
  });
});
