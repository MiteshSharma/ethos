// @vitest-environment jsdom
//
// The way OUT of the takeover mode, when the way out breaks.
//
// The mode has two hand-backs on purpose (see `TakeoverMode.tsx`): the lane's
// `handback` frame while the screencast is live, and `clarify.respond` when it
// is not. They share one button, so the button's disabled state is the whole of
// what tells an operator whether a hand-back is still in flight. A lane that
// drops after the frame goes out and before the server answers left that flag
// set until unmount: the hook reported the lane unavailable, the fallback was
// right there, and the button that reaches it was dead.

import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import {
  type BrowserTakeoverClientFrame,
  type BrowserTakeoverServerFrame,
  decodeBrowserTakeoverClientFrame,
  encodeBrowserTakeoverFrame,
} from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const respondFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: { clarify: { respond: (...args: unknown[]) => respondFn(...args) } },
}));

const { TakeoverMode } = await import('../TakeoverMode');

/** A `WebSocket` the test opens, feeds and drops by hand. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readonly OPEN = 1;
  readonly sent: Uint8Array[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    FakeSocket.last = this;
  }

  send(data: ArrayBufferView | ArrayBuffer): void {
    this.sent.push(
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer),
    );
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server speaking, through the real codec. */
  deliver(frame: BrowserTakeoverServerFrame): void {
    const bytes = encodeBrowserTakeoverFrame(frame);
    const owned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(owned).set(bytes);
    this.onmessage?.({ data: owned });
  }
}

const REQUEST: ClarifyRequestEvent = {
  type: 'clarify.request',
  requestId: 'req-1',
  question: 'Sign in and hand the browser back.',
  defaultDeadlineAt: null,
  kind: 'browser_takeover',
  meta: { sessionId: 'sess-1', url: 'https://example.com/login' },
};

let container: HTMLDivElement;
let root: Root;

/** What this client actually sent, through the real codec. */
function sentFrames(ws: FakeSocket): BrowserTakeoverClientFrame[] {
  return ws.sent.flatMap((bytes) => {
    const decoded = decodeBrowserTakeoverClientFrame(bytes);
    return decoded ? [decoded.header] : [];
  });
}

function handBackButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.takeover-stage-handback');
  expect(button, 'missing hand-back button').not.toBeNull();
  return button as HTMLButtonElement;
}

/** Mount, connect and reach `live` — the state a lane hand-back starts from. */
async function live(): Promise<FakeSocket> {
  await act(async () => {
    root.render(
      createElement(TakeoverMode, {
        request: REQUEST,
        startedAt: Date.now(),
        onBackToChat: () => {},
      }),
    );
  });
  const socket = FakeSocket.last;
  expect(socket, 'the hook never opened a socket').not.toBeNull();
  const ws = socket as FakeSocket;
  await act(async () => {
    ws.readyState = ws.OPEN;
    ws.onopen?.();
    ws.deliver({ t: 'ready', url: 'https://example.com/login', protocolVersion: 1 });
  });
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.last = null;
  respondFn.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('hand-back when the lane goes away underneath it', () => {
  it('re-enables the fallback button when the socket drops mid-hand-back', async () => {
    const ws = await live();
    await act(async () => handBackButton().click());
    // The frame went out and the button says so.
    expect(handBackButton().disabled).toBe(true);
    expect(handBackButton().textContent).toContain('Handing back');

    // The socket dies before the server answers. Nothing resolved the clarify,
    // so the browser is still the operator's — and the fallback is the only
    // way to give it back.
    await act(async () => {
      ws.readyState = 3;
      ws.onclose?.();
    });
    expect(handBackButton().disabled).toBe(false);
    expect(handBackButton().textContent).toContain('Hand back');

    // Legible, not merely enabled: glyph AND word for the state, and a
    // sentence saying the attempt did not land.
    expect(container.textContent).toContain('⚠ no live view');
    expect(container.textContent).toContain('Press Hand back again');

    // ...and pressing it reaches the fallback.
    await act(async () => handBackButton().click());
    expect(respondFn).toHaveBeenCalledWith({
      requestId: 'req-1',
      answer: 'handed back',
      source: 'user',
    });
  });

  it('re-enables the fallback button when the server refuses with handback_failed', async () => {
    const ws = await live();
    await act(async () => handBackButton().click());
    expect(handBackButton().disabled).toBe(true);

    await act(async () => {
      ws.deliver({
        t: 'error',
        code: 'handback_failed',
        message: 'The hand-back did not go through: clarify request not found.',
      });
    });
    expect(handBackButton().disabled).toBe(false);
    // The lane's own sentence, not this component's guess.
    expect(container.textContent).toContain('clarify request not found');
  });

  it('keeps the button disabled while the FALLBACK hand-back is in flight', async () => {
    // The lane never connected, so the first press is already `clarify.respond`
    // — and it runs while the lane reads `unavailable`, which must not be read
    // as "the hand-back fell through".
    let settle: () => void = () => {};
    respondFn.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        settle = () => resolve({ ok: true });
      }),
    );
    await act(async () => {
      root.render(
        createElement(TakeoverMode, {
          request: REQUEST,
          startedAt: Date.now(),
          onBackToChat: () => {},
        }),
      );
    });
    const ws = FakeSocket.last as FakeSocket;
    await act(async () => {
      ws.readyState = 3;
      ws.onclose?.();
    });

    await act(async () => handBackButton().click());
    expect(handBackButton().disabled).toBe(true);
    await act(async () => settle());
  });

  it('keeps the picture live and the retry working after handback_failed', async () => {
    // The server refuses a hand-back WITHOUT closing the lane: it restarts the
    // screencast and says "the browser is still yours — try again". The client
    // used to answer that by painting `unavailable` over a live picture, and
    // `TakeoverStage` gates every click and keystroke on `live` — so the retry
    // the sentence invites was the one thing the mode had just made impossible.
    const ws = await live();
    await act(async () => {
      ws.deliver({ t: 'frame', seq: 1, width: 1280, height: 800 });
    });
    expect(container.querySelector('.takeover-stage-view')).not.toBeNull();

    await act(async () => handBackButton().click());
    await act(async () => {
      ws.deliver({
        t: 'error',
        code: 'handback_failed',
        message: 'The hand-back did not go through: that request is no longer open.',
      });
    });

    // Still driving, still looking at the page, and told why.
    expect(container.textContent).toContain('● you are driving');
    expect(container.textContent).not.toContain('no live view');
    expect(container.querySelector('.takeover-stage-view')).not.toBeNull();
    expect(container.textContent).toContain('no longer open');
    expect(handBackButton().disabled).toBe(false);

    // Input still reaches the page...
    await act(async () => {
      const view = container.querySelector('.takeover-stage-view') as HTMLElement;
      view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(sentFrames(ws).some((f) => f.t === 'mouse')).toBe(true);

    // ...and the retry goes back down the LANE, not to the fallback RPC.
    await act(async () => handBackButton().click());
    expect(sentFrames(ws).filter((f) => f.t === 'handback')).toHaveLength(2);
    expect(respondFn).not.toHaveBeenCalled();
    // The stale refusal is gone the moment a new attempt is outstanding.
    expect(container.textContent).not.toContain('no longer open');
    expect(handBackButton().disabled).toBe(true);
  });

  it('renders the SERVER’s reason when the fallback RPC refuses', async () => {
    // `clarify.respond` throws with a sentence built from the bridge's own
    // `ClarifyRespondOutcome` — three different causes, each true only for
    // itself. This component used to catch and discard it, substituting one
    // fixed line ending "Try again.", which is wrong advice for all three: two
    // of them mean the question is already settled and the third means the row
    // is open but this surface can never be the one to close it.
    respondFn.mockRejectedValue(
      new Error(
        'That answer did not land: that request was already answered somewhere else, and the first answer is the one the agent received.',
      ),
    );
    await act(async () => {
      root.render(
        createElement(TakeoverMode, {
          request: REQUEST,
          startedAt: Date.now(),
          onBackToChat: () => {},
        }),
      );
    });
    const ws = FakeSocket.last as FakeSocket;
    await act(async () => {
      ws.readyState = 3;
      ws.onclose?.();
    });

    await act(async () => handBackButton().click());

    expect(container.textContent).toContain('already answered somewhere else');
    expect(container.textContent).not.toContain('Try again');
    expect(handBackButton().disabled).toBe(false);
  });

  it('stays disabled after a hand-back the lane actually completed', async () => {
    const ws = await live();
    await act(async () => handBackButton().click());
    await act(async () => ws.deliver({ t: 'closed', reason: 'handed_back' }));
    expect(handBackButton().disabled).toBe(true);
    expect(container.textContent).toContain('✓ handed back');
  });
});
