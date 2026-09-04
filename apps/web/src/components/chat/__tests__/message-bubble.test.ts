// @vitest-environment jsdom
//
// "The answer is content only" (feedback & activity contract §1). The bubble
// holds what the agent made FOR the reader — text, images, HTML, PDF, cards,
// the delegated-run card — and never the machinery that produced it. These
// cases assert both halves: no tool chrome inside, the artifacts still inline,
// and the account of the work sitting under the bubble as a footer.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn } from '../../../lib/chat-reducer';
import type { TrailEntry } from '../../../lib/trail';

vi.mock('../../../rpc', () => ({
  rpc: { meta: { capabilities: () => Promise.resolve({ capabilities: { voice_tts: false } }) } },
}));

const { AssistantBubble } = await import('../MessageBubble');

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

function turn(blocks: AssistantTurn['blocks']): AssistantTurn {
  return { id: 'asst-1', role: 'assistant', blocks, timestamp: 0 };
}

function render(blocks: AssistantTurn['blocks'], trail?: TrailEntry[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AssistantBubble, {
          turn: turn(blocks),
          ...(trail ? { trail } : {}),
        }),
      ),
    );
  });
}

describe('AssistantBubble', () => {
  it('renders no tool chip or tool block, however much the turn did', () => {
    render(
      [{ kind: 'text', content: 'Checked the file.' }],
      [
        { kind: 'action', toolCallId: 'tc1', toolName: 'read_file', args: {}, status: 'ok' },
        { kind: 'action', toolCallId: 'tc2', toolName: 'bash', args: {}, status: 'failed' },
      ],
    );
    const bubble = container.querySelector('.message-assistant');
    expect(bubble?.querySelector('.tool-chip')).toBeNull();
    // Nothing about the machinery leaks into the answer itself.
    expect(bubble?.textContent).not.toContain('read_file');
    expect(bubble?.textContent).toContain('Checked the file.');
  });

  it('puts the account of the work UNDER the bubble as a footer', () => {
    render(
      [{ kind: 'text', content: 'Done.' }],
      [{ kind: 'action', toolCallId: 'tc1', toolName: 'read_file', args: {}, status: 'ok' }],
    );
    const footer = container.querySelector('.trail-footer');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain('✓ 1 action');
    // Outside the bubble, not inside it.
    expect(container.querySelector('.message-assistant .trail-footer')).toBeNull();
  });

  it('draws no footer for a turn that only wrote', () => {
    render([{ kind: 'text', content: 'Hello.' }]);
    expect(container.querySelector('.trail-footer')).toBeNull();
  });

  it('still renders the artifacts the agent made — image, html, pdf, card', () => {
    render([
      { kind: 'image', toolCallId: 'tc1', src: 'data:image/png;base64,AA', alt: 'a chart' },
      { kind: 'html', toolCallId: 'tc2', html: '<b>hi</b>', title: 'preview' },
      { kind: 'pdf', toolCallId: 'tc3', src: 'data:application/pdf;base64,AA', title: 'report' },
      {
        kind: 'card',
        toolCallId: 'tc4',
        card: {
          kind: 'alert',
          specVersion: 1,
          payload: { severity: 'info', message: 'Prices refreshed.' },
        },
      },
    ]);
    const bubble = container.querySelector('.message-assistant');
    expect(bubble?.querySelector('img')).not.toBeNull();
    expect(bubble?.querySelector('iframe')).not.toBeNull();
    expect(bubble?.textContent).toContain('Prices refreshed.');
  });

  it('renders nothing for a run anchor with no live surface behind it', () => {
    // A frozen card would be a lie about a live run; nothing is the honest
    // rendering (pi-delegation §4.1).
    render([{ kind: 'run', jobId: 'job_1', runner: 'pi' }]);
    expect(container.querySelector('.message-assistant')?.textContent).toBe('');
  });
});
