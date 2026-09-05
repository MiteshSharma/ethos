// The takeover answer gate — `isClarifyAnswerableOn`, enforced in
// `ClarifyBridge.respond()`.
//
// A `browser_takeover` carries no `options`, and "no options" is the shape
// every text surface reads as free-form. Telegram opened a force reply,
// WhatsApp matched any message in the chat, Discord drew an Answer button over
// a text modal — three independent paths, each correct-looking alone, each
// resolving the row with `source: 'user'`, which `browser_request_takeover`
// reports to the agent as `handed_back: true`. Someone typing "ok" told the
// agent a login it was about to depend on had happened.
//
// The rule is therefore tested HERE, at the one funnel every surface's answer
// passes through in every process, rather than only in each adapter's suite:
// this is the assertion a fifth adapter cannot get out from under.
//
// Revert the `acceptsUserAnswer` call in `clarify-bridge.ts` and every
// `refuses` test below fails.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, ClarifySurfaceType, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';
import { isClarifyAnswerableOn } from '../clarify/takeover-handback';

const CHANNELS: ClarifySurfaceType[] = ['telegram', 'slack', 'discord', 'whatsapp'];
const HANDBACK: ClarifySurfaceType[] = ['web', 'tui', 'cli'];

interface Harness {
  bridge: ClarifyBridge;
  store: FileClarifyStore;
  /** Rows the surface was asked to show. */
  presented: PendingClarify[];
  /** Every `onResolved` notification, in order. */
  resolved: (ClarifyResponse | null)[];
}

function makeHarness(surfaceType: ClarifySurfaceType): Harness {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  const bridge = new ClarifyBridge(store, { reconcilePollMs: 0 });
  const presented: PendingClarify[] = [];
  const resolved: (ClarifyResponse | null)[] = [];
  bridge.registerPresenter(surfaceType, (row) => {
    presented.push(row);
  });
  bridge.onResolved((_row, resp) => {
    resolved.push(resp);
  });
  return { bridge, store, presented, resolved };
}

/** Starts a takeover on `surfaceType` and waits until it has been presented. */
async function startTakeover(
  h: Harness,
  surfaceType: ClarifySurfaceType,
  timeoutMs = 900_000,
): Promise<{ requestId: string; settled: Promise<ClarifyResponse> }> {
  let requestId = '';
  const settled = h.bridge.request({
    question: 'Take over the browser at https://accounts.example.com/signin — log in',
    timeoutMs,
    answerableBy: 'anyone',
    sessionId: 's1',
    surfaceType,
    kind: 'browser_takeover',
    meta: { url: 'https://accounts.example.com/signin', sessionId: 'browser-7' },
    onRequestId: (id) => {
      requestId = id;
    },
  });
  // `presentNow` awaits a store write before invoking the presenter.
  while (h.presented.length === 0) await new Promise((r) => setImmediate(r));
  return { requestId, settled };
}

describe('isClarifyAnswerableOn', () => {
  it('is true for every ordinary question, on every surface', () => {
    for (const surface of [...CHANNELS, ...HANDBACK]) {
      expect(isClarifyAnswerableOn({}, surface)).toBe(true);
      expect(isClarifyAnswerableOn({ kind: 'question' }, surface)).toBe(true);
    }
  });

  it('is false for a browser_takeover on every channel surface', () => {
    for (const surface of CHANNELS) {
      expect(isClarifyAnswerableOn({ kind: 'browser_takeover' }, surface)).toBe(false);
    }
  });

  it('is true for a browser_takeover only where a browser can actually be handed back', () => {
    for (const surface of HANDBACK) {
      expect(isClarifyAnswerableOn({ kind: 'browser_takeover' }, surface)).toBe(true);
    }
  });
});

describe('ClarifyBridge.respond — a takeover cannot be answered from a channel', () => {
  for (const surface of CHANNELS) {
    it(`refuses a 'user' answer to a takeover routed to ${surface}`, async () => {
      const h = makeHarness(surface);
      const { requestId, settled } = await startTakeover(h, surface);

      await h.bridge.respond({ requestId, answer: 'ok, logged in', source: 'user' });

      // Nothing resolved: no listener fired, the row is still open with no
      // answer on it, and the tool is still parked.
      expect(h.resolved).toHaveLength(0);
      const row = await h.store.get(requestId);
      expect(row).not.toBeNull();
      expect(row?.answer).toBeUndefined();

      // ...and it still resolves the ways that remain, so the browser's
      // takeover lock is not stranded.
      await h.bridge.respond({ requestId, answer: '', source: 'cancel' });
      expect((await settled).source).toBe('cancel');
      expect(await h.store.get(requestId)).toBeNull();
    });
  }

  it('refuses the cross-process answer a peer bridge would write onto the row', async () => {
    // A channel surface living in ANOTHER process calls `respond()` on a row
    // this bridge never held. That branch records the answer for the owner to
    // reconcile — which would smuggle the hand-back through the back door.
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const peer = new ClarifyBridge(store, { reconcilePollMs: 0 });
    const notified: (ClarifyResponse | null)[] = [];
    peer.onResolved((_row, resp) => notified.push(resp));
    await store.add(row({ surfaceType: 'whatsapp', kind: 'browser_takeover' }));

    await peer.respond({ requestId: 'r1', answer: 'handed back', source: 'user' });

    expect(notified).toHaveLength(0);
    expect((await store.get('r1'))?.answer).toBeUndefined();
  });
});

describe('ClarifyBridge.respond — what the gate deliberately leaves open', () => {
  for (const surface of HANDBACK) {
    it(`still hands back a takeover from ${surface}`, async () => {
      const h = makeHarness(surface);
      const { requestId, settled } = await startTakeover(h, surface);

      await h.bridge.respond({ requestId, answer: 'handed back', source: 'user' });

      const response = await settled;
      expect(response).toEqual({ requestId, answer: 'handed back', source: 'user' });
      expect(h.resolved).toEqual([response]);
    });
  }

  it('still answers an ordinary question on a channel (the control)', async () => {
    const h = makeHarness('telegram');
    let requestId = '';
    const settled = h.bridge.request({
      question: 'Which database?',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      surfaceType: 'telegram',
      onRequestId: (id) => {
        requestId = id;
      },
    });
    while (h.presented.length === 0) await new Promise((r) => setImmediate(r));

    await h.bridge.respond({ requestId, answer: 'postgres', source: 'user' });
    expect((await settled).answer).toBe('postgres');
  });

  it('still answers a row persisted before `kind` existed', async () => {
    const h = makeHarness('telegram');
    // Written in the pre-D3 shape: no `kind` at all, which means `question`.
    await h.store.add(row({ surfaceType: 'telegram' }));
    await h.bridge.respond({ requestId: 'r1', answer: 'postgres', source: 'user' });
    expect(h.resolved).toEqual([{ requestId: 'r1', answer: 'postgres', source: 'user' }]);
  });

  it('still times out a takeover nobody can answer', async () => {
    const h = makeHarness('telegram');
    const { settled } = await startTakeover(h, 'telegram', 5);
    await expect(settled).rejects.toThrow(/timed out/i);
    expect(h.resolved).toEqual([null]);
  });

  it('still times out to a default, and still cancels a whole job', async () => {
    const h = makeHarness('discord');
    let requestId = '';
    const settled = h.bridge.request({
      question: 'Take over the browser',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      jobId: 'job-1',
      surfaceType: 'discord',
      kind: 'browser_takeover',
      onRequestId: (id) => {
        requestId = id;
      },
    });
    while (h.presented.length === 0) await new Promise((r) => setImmediate(r));

    expect(await h.bridge.cancelJob('job-1')).toBe(1);
    expect((await settled).source).toBe('cancel');
    expect(await h.store.get(requestId)).toBeNull();
  });
});

function row(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'r1',
    sessionId: 's1',
    surfaceType: 'telegram',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    presentedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}
