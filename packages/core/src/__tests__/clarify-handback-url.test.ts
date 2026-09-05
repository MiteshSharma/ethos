// D3 (plan/phases/stealth-browsing-and-takeover.md) — who fills
// `ClarifyMeta.handbackUrl`.
//
// The field was plumbed end-to-end by the takeover lane but nothing ever set
// it, so every channel user was told to "open the web chat" and not told
// where. The address is an operator/deployment fact (`EthosConfig.webBaseUrl`,
// which already resolves `ETHOS_PUBLIC_URL` first) — the browser tool cannot
// know it — so it is composed at row construction, in the bridge, and reaches
// every surface through the row that is persisted before it is presented.
//
// Two halves are under test: the composition itself, and the promise that a
// deployment which never configured a web address gets EXACTLY the text it got
// before this existed. The degraded string is asserted verbatim, not by
// `.not.toContain('http')`, so a regression in the fallback is caught.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifySurfaceType, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';
import { clarifyPromptText, handbackUrlFor } from '../clarify/takeover-prompt';

/** The text a deployment with no configured web address has always rendered. */
const DEGRADED =
  "I'm stuck on a login at accounts.example.com — the browser window is open on the machine running Ethos; open the web chat to hand back";

function presentedOnce(bridge: ClarifyBridge, surfaceType: ClarifySurfaceType) {
  return new Promise<PendingClarify>((resolve) => {
    bridge.registerPresenter(surfaceType, (row) => resolve(row));
  });
}

/**
 * Drives one takeover clarify through a bridge built with `webBaseUrl` and
 * returns the row as it was persisted — the shape every surface reads.
 */
async function takeover(
  webBaseUrl: string | undefined,
  meta: Record<string, string> = { url: 'https://accounts.example.com/signin' },
): Promise<PendingClarify> {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  const bridge = new ClarifyBridge(
    store,
    webBaseUrl !== undefined ? { webBaseUrl, reconcilePollMs: 0 } : { reconcilePollMs: 0 },
  );
  const shown = presentedOnce(bridge, 'telegram');
  const pending = bridge.request({
    question: 'stuck on a login',
    timeoutMs: 900_000,
    answerableBy: 'anyone',
    sessionId: 'telegram:12345',
    surfaceType: 'telegram',
    kind: 'browser_takeover',
    meta,
  });
  const presented = await shown;
  const persisted = await store.get(presented.requestId);
  // `cancel`, not a hand-back: a takeover routed to a CHANNEL can no longer be
  // answered from one (`isClarifyAnswerableOn`), and `respond()` refuses it
  // silently — a `source: 'user'` here would leave `pending` unsettled forever.
  // Cancel is the release path that stays open on a channel, which is what
  // keeps the browser's takeover lock clearable from there.
  await bridge.respond({ requestId: presented.requestId, answer: '', source: 'cancel' });
  await pending;
  if (!persisted) throw new Error('row was not persisted');
  return persisted;
}

describe('handbackUrlFor', () => {
  it('composes the web chat address from a configured base URL', () => {
    expect(handbackUrlFor('https://ethos.example.com')).toBe('https://ethos.example.com/chat');
  });

  it('drops a trailing slash rather than doubling it', () => {
    expect(handbackUrlFor('https://ethos.example.com/')).toBe('https://ethos.example.com/chat');
  });

  it('keeps a path prefix and a non-default port', () => {
    expect(handbackUrlFor('http://127.0.0.1:8787/ethos/')).toBe('http://127.0.0.1:8787/ethos/chat');
  });

  it('is undefined when nothing is configured', () => {
    expect(handbackUrlFor(undefined)).toBeUndefined();
    expect(handbackUrlFor('')).toBeUndefined();
  });

  it('is undefined rather than a guess when the configured value is not an absolute http(s) URL', () => {
    // A bare host has no scheme to invent, and a non-http scheme is not a page
    // a chat client can open.
    expect(handbackUrlFor('ethos.example.com')).toBeUndefined();
    expect(handbackUrlFor('file:///srv/ethos')).toBeUndefined();
    expect(handbackUrlFor('not a url')).toBeUndefined();
  });
});

describe('ClarifyBridge fills handbackUrl on a browser_takeover row', () => {
  it('persists the composed address, and the channel text names it', async () => {
    const row = await takeover('https://ethos.example.com');
    expect(row.meta?.handbackUrl).toBe('https://ethos.example.com/chat');
    expect(clarifyPromptText(row)).toBe(`${DEGRADED}: https://ethos.example.com/chat`);
  });

  it('leaves a caller-supplied handbackUrl alone', async () => {
    const row = await takeover('https://ethos.example.com', {
      url: 'https://accounts.example.com/signin',
      handbackUrl: 'https://already.example.net/chat',
    });
    expect(row.meta?.handbackUrl).toBe('https://already.example.net/chat');
  });

  it('does not touch an ordinary question — no meta key at all, even with a base URL configured', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(store, {
      webBaseUrl: 'https://ethos.example.com',
      reconcilePollMs: 0,
    });
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
    // Absent, not merely undefined — the persisted shape must stay
    // byte-identical to what a pre-D3 build wrote.
    expect(persisted && 'meta' in persisted).toBe(false);
    await bridge.respond({ requestId: presented.requestId, answer: 'postgres', source: 'user' });
    await pending;
  });
});

describe('a deployment with no reachable web address degrades, and does not guess', () => {
  it('omits handbackUrl entirely when no base URL is configured', async () => {
    const row = await takeover(undefined);
    expect(row.meta && 'handbackUrl' in row.meta).toBe(false);
    expect(clarifyPromptText(row)).toBe(DEGRADED);
  });

  // The desktop app builds its own `WiringConfig` literal (a fixed set of
  // fields, no `webBaseUrl`) and serves the UI on a loopback port it chooses
  // at runtime — there is no public address to compose from. It must get the
  // old text, not `http://localhost:<whatever>/chat`.
  it('omits handbackUrl when the host process has no webBaseUrl to give (desktop-style wiring)', async () => {
    const row = await takeover(undefined, {
      url: 'https://accounts.example.com/signin',
    });
    expect(row.meta?.handbackUrl).toBeUndefined();
    expect(clarifyPromptText(row)).not.toContain('http://localhost');
    expect(clarifyPromptText(row)).toBe(DEGRADED);
  });

  it('degrades rather than emitting a broken URL when webBaseUrl is unparseable', async () => {
    const row = await takeover('ethos.example.com');
    expect(row.meta && 'handbackUrl' in row.meta).toBe(false);
    expect(clarifyPromptText(row)).toBe(DEGRADED);
  });
});
