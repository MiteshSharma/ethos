// `ClarifyBridge.respond()` reports what it DID — `ClarifyRespondOutcome`.
//
// It used to return `Promise<void>`, and web-api inferred the outcome from the
// outside by registering an `onResolved` listener and testing object identity
// against the response it had just handed in. That inference was wrong for one
// case in particular, and it is the case with real consequences: the
// cross-process branch fires `notifyResolved` with the CALLER'S OWN response
// object even when first-writer-wins has just thrown that answer away. So a
// hand-back reported success for an answer the agent never received.
//
// These tests pin all four outcomes at the funnel. The `already_answered` one
// is the regression: revert the `discarded` branch in `respond()` — go back to
// `if (!persisted.answer) { … }` followed by an unconditional `{ resolved:
// true }` — and it is the test that fails.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';

function makeBridge(): { bridge: ClarifyBridge; store: FileClarifyStore } {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  return { bridge: new ClarifyBridge(store, { reconcilePollMs: 0 }), store };
}

/** A row on disk with no in-process entry — the cross-process branch. */
function row(over: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 's1',
    surfaceType: 'web',
    surfaceContext: {},
    question: 'Sign in and hand the browser back.',
    answerableBy: 'anyone',
    createdAt: '2026-08-20T11:00:00.000Z',
    defaultDeadlineAt: '2026-08-20T12:00:00.000Z',
    presentedAt: '2026-08-20T11:00:00.000Z',
    ...over,
  };
}

const answer = (requestId: string): ClarifyResponse => ({
  requestId,
  answer: 'handed back',
  source: 'user',
});

describe('ClarifyBridge.respond outcomes', () => {
  it('resolves an in-process entry', async () => {
    const { bridge } = makeBridge();
    let requestId = '';
    const settled = bridge.request({
      question: 'Which branch?',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      surfaceType: 'web',
      onRequestId: (id) => {
        requestId = id;
      },
    });
    bridge.registerPresenter('web', () => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(await bridge.respond(answer(requestId))).toEqual({ resolved: true });
    await settled;
  });

  it('resolves a row that is only on disk, and records the answer', async () => {
    // The control for the discard test below: same branch, empty `answer`.
    const { bridge, store } = makeBridge();
    await store.add(row());

    expect(await bridge.respond(answer('req-1'))).toEqual({ resolved: true });
    expect((await store.get('req-1'))?.answer).toMatchObject({ source: 'user' });
  });

  it('reports unknown_request when there is no entry and no row', async () => {
    const { bridge } = makeBridge();

    expect(await bridge.respond(answer('req-gone'))).toEqual({
      resolved: false,
      reason: 'unknown_request',
    });
  });

  it('reports not_answerable for a takeover the gate refuses', async () => {
    const { bridge, store } = makeBridge();
    await store.add(row({ kind: 'browser_takeover', surfaceType: 'telegram' }));

    expect(await bridge.respond(answer('req-1'))).toEqual({
      resolved: false,
      reason: 'not_answerable',
    });
    expect((await store.get('req-1'))?.answer).toBeUndefined();
  });

  it('reports already_answered for an answer first-writer-wins DISCARDS', async () => {
    // THE regression. The row already carries a peer process's answer, so the
    // `store.update` below is skipped and the agent will collect the FIRST
    // answer — but `notifyResolved` still fires, with this caller's own
    // response object, which is exactly what the old identity inference read as
    // success. `{ ok: true }` here is a hand-back nobody performed.
    const { bridge, store } = makeBridge();
    const first: ClarifyResponse = { requestId: 'req-1', answer: 'first', source: 'user' };
    await store.add(row({ answer: first }));

    const second: ClarifyResponse = { requestId: 'req-1', answer: 'second', source: 'user' };
    const outcome = await bridge.respond(second);

    expect(outcome).toEqual({ resolved: false, reason: 'already_answered' });
    // And the discard is real — the winner is untouched.
    expect((await store.get('req-1'))?.answer).toEqual(first);
  });

  it('still notifies listeners on the discard path (behaviour unchanged)', async () => {
    // Pinned so the outcome change above cannot be mistaken for permission to
    // stop notifying: a surface with a card up for this row must still be told
    // the question is over.
    const { bridge, store } = makeBridge();
    await store.add(row({ answer: { requestId: 'req-1', answer: 'first', source: 'user' } }));
    const seen: (ClarifyResponse | null)[] = [];
    bridge.onResolved((_r, resp) => {
      seen.push(resp);
    });

    await bridge.respond(answer('req-1'));

    expect(seen).toHaveLength(1);
  });
});
