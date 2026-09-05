// D3 (plan/phases/stealth-browsing-and-takeover.md) — `kind`/`meta` plumbing.
//
// Three things are under test and nothing else: the two fields survive the trip
// from `ClarifyRequestInput` through the bridge into `FileClarifyStore`; a row
// written in the pre-D3 shape (no `kind` at all) still reads back and still
// means `question`; and the text form channel surfaces render names the host
// and carries the hand-back link.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifySurfaceType, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';
import { clarifyPromptText } from '../clarify/takeover-prompt';

/** Resolves with the first row the bridge presents on `surfaceType`. */
function presentedOnce(bridge: ClarifyBridge, surfaceType: ClarifySurfaceType) {
  return new Promise<PendingClarify>((resolve) => {
    bridge.registerPresenter(surfaceType, (row) => resolve(row));
  });
}

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'r1',
    sessionId: 's1',
    surfaceType: 'cli',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    presentedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('clarify kind/meta plumbing (D3)', () => {
  it('round-trips kind and meta from ClarifyRequestInput through the bridge to the store', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(store);
    const shown = presentedOnce(bridge, 'web');

    const pending = bridge.request({
      question: 'stuck on a login',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      surfaceType: 'web',
      kind: 'browser_takeover',
      meta: {
        url: 'https://example.com/login?next=/app',
        sessionId: 'browser-7',
        handbackUrl: 'https://ethos.local/chat/s1',
      },
    });

    // The presenter sees the row the store was handed.
    const presented = await shown;
    expect(presented.kind).toBe('browser_takeover');
    expect(presented.meta?.url).toBe('https://example.com/login?next=/app');

    const persisted = await store.get(presented.requestId);
    expect(persisted?.kind).toBe('browser_takeover');
    expect(persisted?.meta).toEqual({
      url: 'https://example.com/login?next=/app',
      sessionId: 'browser-7',
      handbackUrl: 'https://ethos.local/chat/s1',
    });

    await bridge.respond({
      requestId: persisted?.requestId ?? '',
      answer: 'handed back',
      source: 'user',
    });
    await pending;
  });

  it('persists an ordinary question with no kind and no meta keys at all', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(store);
    const shown = presentedOnce(bridge, 'cli');

    const pending = bridge.request({
      question: 'Which database?',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      surfaceType: 'cli',
    });

    const presented = await shown;
    const persisted = await store.get(presented.requestId);
    expect(persisted).not.toBeNull();
    // Not merely undefined — absent, so the persisted shape is byte-identical
    // to what a pre-D3 build wrote.
    expect(persisted && 'kind' in persisted).toBe(false);
    expect(persisted && 'meta' in persisted).toBe(false);

    await bridge.respond({
      requestId: persisted?.requestId ?? '',
      answer: 'postgres',
      source: 'user',
    });
    await pending;
  });

  // The compatibility promise, proven against the OLD shape written directly to
  // disk — not through the new writer, which would beg the question.
  it('reads a row written without kind as a question', async () => {
    const storage = new InMemoryStorage();
    const legacy = {
      requestId: 'legacy-1',
      sessionId: 's1',
      surfaceType: 'web',
      surfaceContext: {},
      question: 'Which database?',
      answerableBy: 'anyone',
      createdAt: '2026-05-15T00:00:00.000Z',
      defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    };
    await storage.mkdir('/ethos/clarify');
    await storage.writeAtomic('/ethos/clarify/pending.json', JSON.stringify([legacy], null, 2));

    const store = new FileClarifyStore(storage, '/ethos/clarify');
    const row = await store.get('legacy-1');
    expect(row).not.toBeNull();
    expect(row?.kind).toBeUndefined();
    expect(row?.kind ?? 'question').toBe('question');
    // And the text surfaces treat it as one: the question, verbatim.
    expect(row && clarifyPromptText(row)).toBe('Which database?');
  });

  it('update() can attach kind and meta to an existing row', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'a' }));
    await store.update('a', {
      kind: 'browser_takeover',
      meta: { url: 'https://shop.example.org/checkout' },
    });
    const row = await store.get('a');
    expect(row?.kind).toBe('browser_takeover');
    expect(row?.meta?.url).toBe('https://shop.example.org/checkout');
  });
});

describe('clarifyPromptText — the channel text form', () => {
  it('returns the question unchanged for an ordinary clarify', () => {
    expect(clarifyPromptText(makeRow({ question: 'Which database?' }))).toBe('Which database?');
    expect(clarifyPromptText(makeRow({ kind: 'question', question: 'Which?' }))).toBe('Which?');
  });

  it('names the host and carries the hand-back link for a takeover', () => {
    const text = clarifyPromptText(
      makeRow({
        kind: 'browser_takeover',
        question: 'stuck on a login',
        meta: {
          url: 'https://accounts.example.com/signin?flow=2',
          handbackUrl: 'https://ethos.local/chat/s1',
        },
      }),
    );
    expect(text).toBe(
      "I'm stuck on a login at accounts.example.com — the browser window is open on the machine running Ethos; open the web chat to hand back: https://ethos.local/chat/s1",
    );
    expect(text).toContain('accounts.example.com');
    expect(text).toContain('https://ethos.local/chat/s1');
  });

  it('still points at the web chat when the deployment has no reachable link', () => {
    const text = clarifyPromptText(
      makeRow({ kind: 'browser_takeover', meta: { url: 'https://example.com/login' } }),
    );
    expect(text).toBe(
      "I'm stuck on a login at example.com — the browser window is open on the machine running Ethos; open the web chat to hand back",
    );
  });

  it('drops the host clause rather than printing a broken URL', () => {
    expect(
      clarifyPromptText(makeRow({ kind: 'browser_takeover', meta: { url: 'not a url' } })),
    ).toBe(
      "I'm stuck on a login — the browser window is open on the machine running Ethos; open the web chat to hand back",
    );
    expect(clarifyPromptText(makeRow({ kind: 'browser_takeover' }))).toContain(
      'the browser window is open on the machine running Ethos',
    );
  });
});
