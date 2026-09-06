import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BROWSER_TAKEOVER_SOCKET_PATH,
  type BrowserTakeoverClientFrame,
  type BrowserTakeoverServerFrame,
  decodeBrowserTakeoverServerFrame,
  encodeBrowserTakeoverFrame,
  MAX_TAKEOVER_CLIENT_FRAME_BYTES,
  MAX_TAKEOVER_FRAME_BYTES,
  MAX_TAKEOVER_ID_CHARS,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { readCookie } from '../../voice/voice-socket';
import {
  createTakeoverSocket,
  MAX_TAKEOVER_FRAME_BASE64_CHARS,
  MAX_TAKEOVER_PAGE_DIMENSION,
  type TakeoverCdpSession,
  type TakeoverHandback,
  type TakeoverSocket,
  type TakeoverSocketOptions,
  type TakeoverTarget,
} from '../takeover-socket';

// The socket half of the screencast takeover: upgrade policy (Origin,
// credentials), the round trip over a REAL `ws` connection, and the two things
// that are only true on a socket — a second tab evicting the first, and a
// session this process cannot see refusing rather than drawing nothing.

const COOKIE = 'ethos_auth=good-token';

/** A `CDPSession` stand-in this file drives from outside. */
class FakeCdp implements TakeoverCdpSession {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = 0;
  private listeners = new Map<string, Array<(payload: unknown) => void>>();
  /** Set to make `send` reject — the screencast-start failure path. */
  failOn: string | null = null;
  /**
   * Fires INSIDE `send`, before it resolves. The only way to drive the race a
   * hand-back has to survive: the takeover settling somewhere else while this
   * lane is awaiting CDP.
   */
  onSend: ((method: string) => void) | null = null;

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.onSend?.(method);
    if (this.failOn === method) return Promise.reject(new Error(`no ${method}`));
    this.sent.push(params === undefined ? { method } : { method, params });
    return Promise.resolve({});
  }

  on(event: string, listener: (payload: unknown) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  off(event: string, listener: (payload: unknown) => void): unknown {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== listener),
    );
    return this;
  }

  detach(): Promise<void> {
    this.detached += 1;
    return Promise.resolve();
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  paramsFor(method: string): Record<string, unknown> | undefined {
    return this.sent.find((call) => call.method === method)?.params;
  }
}

function jpegFrame(sessionId: number, bytes: number, url?: string) {
  return {
    data: Buffer.alloc(bytes, 0x41).toString('base64'),
    sessionId,
    metadata: { deviceWidth: 1000, deviceHeight: 500, offsetTop: 0, ...(url ? {} : {}) },
  };
}

/** One connected client, frames decoded through the REAL codec both ways. */
function openClient(url: string, headers: Record<string, string>, path: string) {
  const ws = new WebSocket(`${url}${path}`, { headers });
  const frames: BrowserTakeoverServerFrame[] = [];
  const payloads: Uint8Array[] = [];
  ws.on('message', (data: Buffer) => {
    const decoded = decodeBrowserTakeoverServerFrame(new Uint8Array(data));
    if (decoded) {
      frames.push(decoded.header);
      payloads.push(decoded.payload);
    }
  });
  const send = (frame: BrowserTakeoverClientFrame) =>
    ws.send(encodeBrowserTakeoverFrame(frame), { binary: true });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  // The two upgrade-refusal tests never await `opened`; a rejection with no
  // handler would surface as an unhandled rejection and fail the file.
  opened.catch(() => undefined);
  return { ws, frames, payloads, send, opened };
}

/** Poll until `check` passes — the socket round trip is asynchronous. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('browser takeover socket', () => {
  let server: Server;
  let lane: TakeoverSocket;
  let url: string;
  let cdp: FakeCdp;
  let target: TakeoverTarget;
  let pageUrl: string;
  let closed: boolean;
  let handback: ReturnType<typeof vi.fn<TakeoverHandback>>;
  let find: (sessionId: string) => TakeoverTarget | null;
  /** The tool-side settle notification, driven by hand from the tests. */
  let settleListeners: Array<(sessionId: string, requestId: string) => void>;

  beforeEach(async () => {
    cdp = new FakeCdp();
    pageUrl = 'https://example.com/login';
    closed = false;
    target = {
      page: { url: () => pageUrl, isClosed: () => closed },
      newCDPSession: () => Promise.resolve(cdp),
      // The lock names the clarify the agent is parked on, and every lane is
      // bound to THAT id — `hello` refuses any other, and every input frame
      // re-reads it.
      takeover: { requestId: 'req-1' },
    };
    find = (sessionId) => (sessionId === 'sess-1' ? target : null);
    handback = vi.fn((_requestId: string) => Promise.resolve({ resolved: true as const }));
    server = createServer((_req, res) => res.end('ok'));
    settleListeners = [];
    lane = createTakeoverSocket({
      sessions: {
        find: (id) => find(id),
        onSettled: (listener) => {
          settleListeners.push(listener);
          return () => {
            settleListeners = settleListeners.filter((l) => l !== listener);
          };
        },
      },
      handback,
      authenticate: (req) =>
        Promise.resolve(readCookie(req.headers.cookie, 'ethos_auth') === 'good-token'),
    });
    lane.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await lane.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(headers: Record<string, string> = { cookie: COOKIE }) {
    return openClient(url, headers, BROWSER_TAKEOVER_SOCKET_PATH);
  }

  async function ready(client = open()) {
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'ready'), 'ready frame');
    return client;
  }

  it('refuses an upgrade without the auth cookie', async () => {
    const { ws } = open({});
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(401);
  });

  it('refuses an upgrade from a disallowed Origin', async () => {
    const { ws } = open({ cookie: COOKIE, origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(403);
  });

  it('starts a bounded screencast and reports the page URL on hello', async () => {
    const client = await ready();
    expect(client.frames[0]).toEqual({
      t: 'ready',
      url: 'https://example.com/login',
      protocolVersion: 1,
    });
    const params = cdp.paramsFor('Page.startScreencast');
    expect(params?.format).toBe('jpeg');
    // The dimension/quality caps are the FIRST half of bounding a lane whose
    // payload the frame codec does not cap.
    expect(params?.maxWidth).toBe(1280);
    expect(params?.maxHeight).toBe(800);
    expect(params?.quality).toBe(60);
    client.ws.close();
  });

  it('refuses honestly when this process cannot see the session', async () => {
    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: 'not-here', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'error frame');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('session_unavailable');
    expect(frame?.t === 'error' && frame.message).toContain('no browser session');
    // No screencast was started for a session that is not here.
    expect(cdp.paramsFor('Page.startScreencast')).toBeUndefined();
  });

  it('refuses a session that is not handed over', async () => {
    target.takeover = undefined;
    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'error frame');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('not_in_takeover');
  });

  it('delivers screencast frames with their JPEG payload', async () => {
    const client = await ready();
    cdp.emit('Page.screencastFrame', jpegFrame(7, 64));
    await until(() => client.frames.some((f) => f.t === 'frame'), 'screencast frame');
    const index = client.frames.findIndex((f) => f.t === 'frame');
    const frame = client.frames[index];
    expect(frame?.t === 'frame' && frame.seq).toBe(7);
    expect(frame?.t === 'frame' && frame.width).toBe(1000);
    expect(client.payloads[index]?.byteLength).toBe(64);
    // Not acked by the server — the VIEWER acks when it has painted.
    expect(cdp.paramsFor('Page.screencastFrameAck')).toBeUndefined();
    client.ws.close();
  });

  it('drops an oversized frame but still acks it, so the stream continues', async () => {
    const client = await ready();
    cdp.emit('Page.screencastFrame', jpegFrame(9, MAX_TAKEOVER_FRAME_BYTES + 1));
    await until(
      () => cdp.paramsFor('Page.screencastFrameAck') !== undefined,
      'server-side ack of the dropped frame',
    );
    expect(cdp.paramsFor('Page.screencastFrameAck')).toEqual({ sessionId: 9 });
    expect(client.frames.some((f) => f.t === 'frame')).toBe(false);
    client.ws.close();
  });

  it('follows the page URL when a navigation repaints', async () => {
    const client = await ready();
    pageUrl = 'https://example.com/dashboard';
    cdp.emit('Page.screencastFrame', jpegFrame(1, 32));
    await until(() => client.frames.some((f) => f.t === 'url'), 'url frame');
    const frame = client.frames.find((f) => f.t === 'url');
    expect(frame?.t === 'url' && frame.url).toBe('https://example.com/dashboard');
    client.ws.close();
  });

  it('dispatches a click as page coordinates scaled from the frame metadata', async () => {
    const client = await ready();
    cdp.emit('Page.screencastFrame', jpegFrame(1, 32));
    await until(() => client.frames.some((f) => f.t === 'frame'), 'first frame');
    client.send({
      t: 'mouse',
      type: 'mousePressed',
      x: 0.5,
      y: 0.25,
      button: 'left',
      clickCount: 1,
    });
    await until(() => cdp.paramsFor('Input.dispatchMouseEvent') !== undefined, 'mouse dispatch');
    expect(cdp.paramsFor('Input.dispatchMouseEvent')).toMatchObject({
      type: 'mousePressed',
      x: 500,
      y: 125,
      button: 'left',
      clickCount: 1,
    });
    client.ws.close();
  });

  it('dispatches a key event', async () => {
    const client = await ready();
    client.send({ t: 'key', type: 'char', text: 'a', key: 'a' });
    await until(() => cdp.paramsFor('Input.dispatchKeyEvent') !== undefined, 'key dispatch');
    expect(cdp.paramsFor('Input.dispatchKeyEvent')).toMatchObject({ type: 'char', text: 'a' });
    client.ws.close();
  });

  it('forwards the viewer ack to CDP so the next frame is produced', async () => {
    const client = await ready();
    client.send({ t: 'ack', seq: 4 });
    await until(() => cdp.paramsFor('Page.screencastFrameAck') !== undefined, 'ack forwarded');
    expect(cdp.paramsFor('Page.screencastFrameAck')).toEqual({ sessionId: 4 });
    client.ws.close();
  });

  it('ignores a malformed frame with an error rather than closing the lane', async () => {
    const client = await ready();
    client.ws.send(Buffer.from([1, 0, 2, 0x7b, 0x7d]), { binary: true });
    await until(() => client.frames.some((f) => f.t === 'error'), 'bad_frame');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('bad_frame');
    expect(lane.laneCount).toBe(1);
    client.ws.close();
  });

  it('resolves the clarify on hand-back and closes the lane', async () => {
    const client = await ready();
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    expect(handback).toHaveBeenCalledWith('req-1');
    const frame = client.frames.find((f) => f.t === 'closed');
    expect(frame?.t === 'closed' && frame.reason).toBe('handed_back');
    expect(cdp.sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
  });

  it('does NOT hand back when the viewer simply goes away', async () => {
    // A reload, a closed tab, a dropped Wi-Fi link. The takeover is still the
    // agent's reality — it stays parked until a human resolves it or its own
    // timeout fires. Reading a lost socket as a hand-back would tell the agent
    // that a login it is about to depend on has happened.
    const client = await ready();
    client.ws.close();
    await until(() => lane.laneCount === 0, 'lane teardown');
    expect(handback).not.toHaveBeenCalled();
    expect(cdp.detached).toBe(1);
  });

  it('evicts the first tab with `taken_over` when a second opens the same takeover', async () => {
    const first = await ready();
    const second = await ready(open());
    await until(() => first.frames.some((f) => f.t === 'closed'), 'eviction of the first tab');
    const frame = first.frames.find((f) => f.t === 'closed');
    expect(frame?.t === 'closed' && frame.reason).toBe('taken_over');
    expect(second.frames.some((f) => f.t === 'closed')).toBe(false);
    second.ws.close();
  });

  it('refuses when the screencast cannot start, rather than showing a blank canvas', async () => {
    cdp.failOn = 'Page.startScreencast';
    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'screencast_failed');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('screencast_failed');
  });

  // -------------------------------------------------------------------------
  // The lock binds the lane: session AND request, checked on every frame
  // -------------------------------------------------------------------------

  it('refuses a client whose requestId is not the one this takeover is parked on', async () => {
    // The attack this closes: an authenticated viewer opens a lane on a
    // takeover it can legitimately see, but names SOMEONE ELSE'S clarify — it
    // drives this browser and its `handback` resolves an unrelated request.
    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'someone-elses-request' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'error frame');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('not_in_takeover');
    // Nothing was resolved and nothing was driven — the refusal happens before
    // a CDP session exists at all.
    expect(handback).not.toHaveBeenCalled();
    expect(cdp.paramsFor('Page.startScreencast')).toBeUndefined();
    expect(client.frames.some((f) => f.t === 'ready')).toBe(false);
  });

  it('refuses a lock carrying no request id — nothing can be handed back through it', async () => {
    target.takeover = {};
    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'error frame');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('not_in_takeover');
    expect(handback).not.toHaveBeenCalled();
  });

  it('rejects input once the takeover has settled, and closes the lane', async () => {
    const client = await ready();
    // The chat card handed back / the clarify timed out / the turn was
    // cancelled. The tool cleared the lock; this socket still holds its CDP
    // session and is one frame away from typing into the agent's browser.
    target.takeover = undefined;
    client.send({ t: 'mouse', type: 'mousePressed', x: 0.5, y: 0.5, button: 'left' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const frame = client.frames.find((f) => f.t === 'closed');
    expect(frame?.t === 'closed' && frame.reason).toBe('session_gone');
    expect(cdp.paramsFor('Input.dispatchMouseEvent')).toBeUndefined();
    expect(cdp.sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
    await until(() => lane.laneCount === 0, 'lane teardown');
  });

  it('rejects input bound to a takeover that has been REPLACED by a new one', async () => {
    const client = await ready();
    // Same browser session, a second takeover later in the turn. The old
    // lane's id is stale, which the `!== requestId` comparison catches where a
    // "is this session locked at all" check would not.
    target.takeover = { requestId: 'req-2' };
    client.send({ t: 'key', type: 'char', text: 'a', key: 'a' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    expect(cdp.paramsFor('Input.dispatchKeyEvent')).toBeUndefined();
  });

  it('drops screencast frames once the takeover settles rather than painting them', async () => {
    const client = await ready();
    target.takeover = undefined;
    cdp.emit('Page.screencastFrame', jpegFrame(3, 64));
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    expect(client.frames.some((f) => f.t === 'frame')).toBe(false);
  });

  it('closes a live lane the moment the takeover settles, without waiting for the viewer', async () => {
    // The push half. A person who has stopped typing sends nothing, so the
    // per-frame check never fires — and the CDP session outlives the lock.
    const client = await ready();
    target.takeover = undefined;
    for (const listener of settleListeners) listener('sess-1', 'req-1');
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const frame = client.frames.find((f) => f.t === 'closed');
    expect(frame?.t === 'closed' && frame.reason).toBe('session_gone');
    await until(() => lane.laneCount === 0, 'lane teardown');
    expect(cdp.detached).toBe(1);
    expect(cdp.sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
  });

  it('leaves a lane bound to a DIFFERENT takeover alone when one settles', async () => {
    const client = await ready();
    for (const listener of settleListeners) listener('sess-1', 'some-other-request');
    for (const listener of settleListeners) listener('other-session', 'req-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.frames.some((f) => f.t === 'closed')).toBe(false);
    expect(lane.laneCount).toBe(1);
    client.ws.close();
  });

  // -------------------------------------------------------------------------
  // A hand-back is a claim about the agent, not about this socket
  // -------------------------------------------------------------------------

  it('reports a FAILED hand-back as an error and keeps the takeover live', async () => {
    handback.mockRejectedValueOnce(new Error('clarify request not found'));
    const client = await ready();
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'handback_failed');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('handback_failed');
    expect(frame?.t === 'error' && frame.message).toContain('clarify request not found');
    // The lie this test exists to prevent.
    expect(client.frames.some((f) => f.t === 'closed')).toBe(false);
    // Still live, still watchable, and retryable: the screencast the
    // hand-back attempt stopped was started again.
    expect(lane.laneCount).toBe(1);
    expect(cdp.sent.filter((call) => call.method === 'Page.startScreencast')).toHaveLength(2);

    // ...and the retry works once the request is resolvable again.
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const closed = client.frames.find((f) => f.t === 'closed');
    expect(closed?.t === 'closed' && closed.reason).toBe('handed_back');
    expect(handback).toHaveBeenCalledTimes(2);
  });

  it('reports handback_failed when the hand-back RESOLVED NOTHING and did not throw', async () => {
    // The fourth instance of this feature's oldest bug, and the one a caller
    // cannot see: `ClarifyBridge.respond()` returns `void` and swallows a
    // missing, expired, cancelled or already-settled request, so an awaited
    // call that resolves is not evidence that anything happened. The lane's
    // own error message names those four causes; before the result type they
    // all arrived here as `closed: handed_back`.
    handback.mockResolvedValueOnce({
      resolved: false,
      reason: 'that request is no longer open',
    });
    const client = await ready();
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'handback_failed');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('handback_failed');
    expect(frame?.t === 'error' && frame.message).toContain('no longer open');
    // The lie this test exists to prevent.
    expect(client.frames.some((f) => f.t === 'closed')).toBe(false);
    // The takeover is untouched, so the browser is still the human's — and the
    // picture they are still looking at is running again.
    expect(target.takeover).toEqual({ requestId: 'req-1' });
    expect(lane.laneCount).toBe(1);
    expect(cdp.sent.filter((call) => call.method === 'Page.startScreencast')).toHaveLength(2);

    // ...and the retry lands.
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const closed = client.frames.find((f) => f.t === 'closed');
    expect(closed?.t === 'closed' && closed.reason).toBe('handed_back');
  });

  it('does not report handed_back when the clarify settles during the CDP await', async () => {
    // The sequence: the human presses Hand back, and while `Page.stopScreencast`
    // is in flight the takeover settles somewhere else — a 15-minute timeout, an
    // aborted turn, the chat card. The settle push is deliberately MUTED for a
    // lane that is settling, so nothing closes this one, and `respond` then has
    // nothing left to resolve. The agent recorded `cancel`; telling this viewer
    // `handed_back` would be the same lie from a different direction.
    const client = await ready();
    cdp.onSend = (method) => {
      if (method !== 'Page.stopScreencast') return;
      cdp.onSend = null;
      target.takeover = undefined;
      for (const listener of settleListeners) listener('sess-1', 'req-1');
    };
    handback.mockResolvedValueOnce({
      resolved: false,
      reason: 'that request is no longer open',
    });

    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const reasons = client.frames.filter((f) => f.t === 'closed').map((f) => f.reason);
    expect(reasons).toEqual(['session_gone']);
    // Not `handback_failed` either: "the browser is still yours — try again" is
    // advice with nothing left to try, and restarting the screencast would
    // stream a page the agent has resumed driving to a person invited to click
    // on it. Exactly one `startScreencast`, the one `hello` made.
    expect(client.frames.some((f) => f.t === 'error')).toBe(false);
    expect(cdp.sent.filter((call) => call.method === 'Page.startScreencast')).toHaveLength(1);
    await until(() => lane.laneCount === 0, 'lane teardown');
  });

  it('cannot report handed_back when the socket has no hand-back capability', async () => {
    // `handback` is a REQUIRED option precisely so this socket cannot be built
    // by accident — the cast is what the optional field it used to be produced
    // for free, and what a JS caller still can. What must NOT happen is the
    // frame falling past an absent callback into `closed: handed_back`: the
    // operator would be told control was returned while the agent stayed
    // parked on a clarify nothing resolved.
    const withoutHandback: Partial<TakeoverSocketOptions> = {
      sessions: { find: (id) => (id === 'sess-1' ? target : null) },
      authenticate: () => Promise.resolve(true),
    };
    const noHandback = createTakeoverSocket(withoutHandback as TakeoverSocketOptions);
    const bareServer = createServer((_req, res) => res.end('ok'));
    noHandback.attach(bareServer);
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const { port } = bareServer.address() as AddressInfo;
    const client = openClient(`ws://127.0.0.1:${port}`, {}, BROWSER_TAKEOVER_SOCKET_PATH);
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'ready'), 'ready frame');

    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'handback_failed');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('handback_failed');
    // The lie this test exists to prevent.
    expect(client.frames.some((f) => f.t === 'closed')).toBe(false);
    // ...and the clarify is demonstrably unresolved: the lock is untouched, so
    // the agent is still parked and the browser is still the human's.
    expect(target.takeover).toEqual({ requestId: 'req-1' });

    await noHandback.close();
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it('does not let the settle notification overwrite its own hand-back', async () => {
    // `respond` resolving IS what makes the tool clear the lock and notify, so
    // the notification lands right on top of this lane's `handed_back`.
    handback.mockImplementationOnce((requestId: string) => {
      target.takeover = undefined;
      for (const listener of settleListeners) listener('sess-1', requestId);
      return Promise.resolve({ resolved: true as const });
    });
    const client = await ready();
    client.send({ t: 'handback' });
    await until(() => client.frames.some((f) => f.t === 'closed'), 'closed frame');
    const reasons = client.frames.filter((f) => f.t === 'closed').map((f) => f.reason);
    expect(reasons).toEqual(['handed_back']);
  });

  it('refuses every lane when no session registry is wired at all', async () => {
    const bare = createTakeoverSocket({
      handback: () => Promise.resolve({ resolved: true as const }),
      authenticate: () => Promise.resolve(true),
    });
    const bareServer = createServer((_req, res) => res.end('ok'));
    bare.attach(bareServer);
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const { port } = bareServer.address() as AddressInfo;
    const client = openClient(`ws://127.0.0.1:${port}`, {}, BROWSER_TAKEOVER_SOCKET_PATH);
    await client.opened;
    client.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => client.frames.some((f) => f.t === 'error'), 'session_unavailable');
    const frame = client.frames.find((f) => f.t === 'error');
    expect(frame?.t === 'error' && frame.code).toBe('session_unavailable');
    await bare.close();
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  // --- eviction is synchronous ---------------------------------------------
  //
  // Both of these give every lane its OWN `FakeCdp`, the way a real
  // `newCDPSession()` does, and they take their measurement INSIDE the factory:
  // the evictor's session is created a few statements after the eviction, in
  // the same synchronous stretch of `hello`, so what the evicted lane looks
  // like at that moment is exactly what "synchronously" has to mean.

  it("detaches the evicted lane's CDP session synchronously, before the evictor gets one", async () => {
    const sessions: FakeCdp[] = [];
    let detachedAtEviction: number | null = null;
    let stoppedAtEviction = false;
    target.newCDPSession = () => {
      const created = new FakeCdp();
      sessions.push(created);
      if (sessions.length === 2) {
        detachedAtEviction = sessions[0]?.detached ?? -1;
        stoppedAtEviction =
          sessions[0]?.sent.some((call) => call.method === 'Page.stopScreencast') ?? false;
      }
      return Promise.resolve(created);
    };
    const first = await ready();
    const second = await ready(open());
    await until(() => first.frames.some((f) => f.t === 'closed'), 'eviction of the first tab');

    expect(detachedAtEviction).toBe(1);
    expect(stoppedAtEviction).toBe(true);
    // The evictor's own session is untouched.
    expect(sessions[1]?.detached).toBe(0);
    second.ws.close();
  });

  it('does not dispatch input the evicted lane had already queued', async () => {
    const sessions: FakeCdp[] = [];
    const clicks = (session: FakeCdp | undefined) =>
      session?.sent.filter((call) => call.method === 'Input.dispatchMouseEvent').length ?? -1;
    let clicksAtEviction: number | null = null;
    target.newCDPSession = () => {
      const created = new FakeCdp();
      sessions.push(created);
      if (sessions.length === 2) clicksAtEviction = clicks(sessions[0]);
      return Promise.resolve(created);
    };
    const first = await ready();

    // The first viewer keeps clicking straight through the eviction — it has no
    // way to know it happened until the close handshake reaches it. Those are
    // the queued frames: put on the wire while it still held the lane,
    // delivered to the server after the lane was taken away.
    let pumping = true;
    let sentAfterEviction = 0;
    const pump = () => {
      if (!pumping || first.ws.readyState !== WebSocket.OPEN) return;
      first.send({
        t: 'mouse',
        type: 'mousePressed',
        x: 0.5,
        y: 0.5,
        button: 'left',
        clickCount: 1,
      });
      if (clicksAtEviction !== null) sentAfterEviction += 1;
      setImmediate(pump);
    };
    pump();

    const second = await ready(open());
    await until(() => first.frames.some((f) => f.t === 'closed'), 'eviction of the first tab');
    // Let the queue drain: this is the interval the finding is about.
    await new Promise((resolve) => setTimeout(resolve, 50));
    pumping = false;

    // The window was real — the evicted viewer went on sending after the
    // eviction. Without this the assertion below could pass vacuously.
    expect(sentAfterEviction).toBeGreaterThan(0);
    // ...and not one of those frames reached the page.
    expect(clicks(sessions[0])).toBe(clicksAtEviction);
    second.ws.close();
  });

  it('revokes a lane evicted while its own CDP session was still opening', async () => {
    // The window `endLane` alone cannot close: `holders` is claimed BEFORE the
    // `newCDPSession()` await, so a lane can be evicted while its own `hello`
    // is still mid-handshake — at which point `teardown` has no session to
    // detach and no listener to remove. The revoked flag is what the
    // continuation checks when it wakes up.
    const sessions: FakeCdp[] = [];
    // A plain `() => void`, not a nullable one: TypeScript narrows a `let`
    // initialised to `null` back to `null` at the call site below, however the
    // promise executor reassigns it.
    let release = (): void => undefined;
    target.newCDPSession = () => {
      const created = new FakeCdp();
      sessions.push(created);
      // The first lane's session is held open; the evictor's resolves at once.
      if (sessions.length === 1) {
        return new Promise<TakeoverCdpSession>((resolve) => {
          release = () => resolve(created);
        });
      }
      return Promise.resolve(created);
    };

    const first = open();
    await first.opened;
    first.send({ t: 'hello', sessionId: 'sess-1', requestId: 'req-1' });
    await until(() => sessions.length === 1, "the first lane's CDP session opening");
    const second = await ready(open());
    await until(() => first.frames.some((f) => f.t === 'closed'), 'eviction of the first tab');

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The session it was waiting on is detached, not wired up: no screencast,
    // no listener, and no `ready` telling the evicted viewer it is driving.
    expect(sessions[0]?.detached).toBe(1);
    expect(sessions[0]?.sent.some((call) => call.method === 'Page.startScreencast')).toBe(false);
    expect(first.frames.some((f) => f.t === 'ready')).toBe(false);
    second.ws.close();
  });

  // --- the frame bound ------------------------------------------------------

  it('fails the connection on an oversized client frame rather than decoding it', async () => {
    const client = await ready();
    const closeCode = new Promise<number>((resolve) => client.ws.on('close', resolve));
    // Past `maxPayload`, so `ws` fails the connection on the declared length —
    // the bytes are never concatenated, decoded, or looked at by this lane.
    client.ws.send(
      encodeBrowserTakeoverFrame({
        t: 'hello',
        sessionId: 'x'.repeat(MAX_TAKEOVER_CLIENT_FRAME_BYTES),
        requestId: 'req-1',
      }),
      { binary: true },
    );
    // 1009 — "message too big". Not a `bad_frame` error frame: the lane never
    // saw it.
    expect(await closeCode).toBe(1009);
    expect(client.frames.some((f) => f.t === 'error')).toBe(false);
  });

  it('rejects an oversized screencast frame from its ENCODED length, never decoding it', async () => {
    const client = await ready();
    // Past the character bound, so the reject happens on `parsed.data.length`
    // and `Buffer.from` is never reached. That is the whole finding: a cap
    // applied AFTER the decode bounds what is written to the socket while the
    // allocation a hostile page provokes stays unbounded.
    const oversized = jpegFrame(11, MAX_TAKEOVER_FRAME_BYTES + 3);
    expect(oversized.data.length).toBeGreaterThan(MAX_TAKEOVER_FRAME_BASE64_CHARS);
    const decodes = vi.spyOn(Buffer, 'from');
    try {
      cdp.emit('Page.screencastFrame', oversized);
      await until(
        () => cdp.paramsFor('Page.screencastFrameAck') !== undefined,
        'server-side ack of the rejected frame',
      );
      const decodedThePayload = decodes.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].length === oversized.data.length,
      );
      expect(decodedThePayload).toBe(false);
    } finally {
      decodes.mockRestore();
    }
    // Dropped, and STILL acked — an unacked drop ends the stream.
    expect(cdp.paramsFor('Page.screencastFrameAck')).toEqual({ sessionId: 11 });
    expect(client.frames.some((f) => f.t === 'frame')).toBe(false);
    client.ws.close();
  });

  it('still ships a frame at exactly the byte cap — the pre-decode bound is not too tight', async () => {
    const client = await ready();
    const largest = jpegFrame(12, MAX_TAKEOVER_FRAME_BYTES);
    // The arithmetic, asserted: the largest permitted frame encodes to exactly
    // the character bound, so rounding it the other way would reject the frame
    // the byte cap is supposed to admit.
    expect(largest.data.length).toBe(MAX_TAKEOVER_FRAME_BASE64_CHARS);
    cdp.emit('Page.screencastFrame', largest);
    await until(() => client.frames.some((f) => f.t === 'frame'), 'the largest legitimate frame');
    const index = client.frames.findIndex((f) => f.t === 'frame');
    expect(client.payloads[index]?.byteLength).toBe(MAX_TAKEOVER_FRAME_BYTES);
    client.ws.close();
  });

  it('drops a frame whose dimensions are not real, so NaN never scales a click', async () => {
    const client = await ready();
    cdp.emit('Page.screencastFrame', jpegFrame(1, 32));
    await until(() => client.frames.some((f) => f.t === 'frame'), 'the good frame');
    const painted = client.frames.filter((f) => f.t === 'frame').length;

    for (const [deviceWidth, deviceHeight] of [
      [Number.NaN, 500],
      [1000, Number.NaN],
      [Number.POSITIVE_INFINITY, 500],
      [1000, Number.NEGATIVE_INFINITY],
      [-1000, 500],
    ]) {
      cdp.emit('Page.screencastFrame', {
        data: Buffer.alloc(32, 0x41).toString('base64'),
        sessionId: 2,
        metadata: { deviceWidth, deviceHeight, offsetTop: 0 },
      });
    }
    expect(client.frames.filter((f) => f.t === 'frame').length).toBe(painted);

    // The pointer maths still runs on the last frame that reported a real
    // size, rather than on whatever the malformed ones carried.
    client.send({ t: 'mouse', type: 'mousePressed', x: 0.5, y: 0.25, button: 'left' });
    await until(() => cdp.paramsFor('Input.dispatchMouseEvent') !== undefined, 'mouse dispatch');
    expect(cdp.paramsFor('Input.dispatchMouseEvent')).toMatchObject({ x: 500, y: 125 });
    client.ws.close();
  });

  it('acks a malformed frame that still carries a session id, so the stream continues', async () => {
    const client = await ready();
    // The case a "the ack needs `parsed.sessionId`, so it cannot be formed"
    // reading misses: the session id is present and perfectly valid, and it is
    // the REST of the frame that is unusable.
    cdp.emit('Page.screencastFrame', {
      data: Buffer.alloc(32, 0x41).toString('base64'),
      sessionId: 7,
      metadata: { deviceWidth: 'wide', deviceHeight: 500 },
    });
    await until(
      () => cdp.paramsFor('Page.screencastFrameAck') !== undefined,
      'ack for the malformed frame',
    );
    expect(cdp.paramsFor('Page.screencastFrameAck')).toEqual({ sessionId: 7 });
    // The ack is the mechanism; THIS is the property. CDP emits nothing
    // further until the previous frame is acked, so a lane that survives one
    // malformed frame is a lane whose NEXT frame still reaches the viewer.
    cdp.emit('Page.screencastFrame', jpegFrame(8, 32));
    await until(
      () => client.frames.some((f) => f.t === 'frame'),
      'a painted frame after the malformed one',
    );
    const frame = client.frames.find((f) => f.t === 'frame');
    expect(frame?.t === 'frame' && frame.seq).toBe(8);
    client.ws.close();
  });

  it('restarts the screencast when a malformed frame carries no session id to ack', async () => {
    const client = await ready();
    expect(cdp.sent.filter((call) => call.method === 'Page.startScreencast')).toHaveLength(1);
    // No `sessionId` at all — there is nothing to ack, so acking cannot
    // unwedge the stream and a new screencast is the only way back.
    cdp.emit('Page.screencastFrame', {
      data: Buffer.alloc(32, 0x41).toString('base64'),
      metadata: { deviceWidth: 1000, deviceHeight: 500 },
    });
    await until(
      () => cdp.sent.filter((call) => call.method === 'Page.startScreencast').length === 2,
      'the screencast restarted',
    );
    expect(cdp.sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
    expect(cdp.sent.some((call) => call.method === 'Page.screencastFrameAck')).toBe(false);
    // ...and the lane is still the viewer's — frames land again.
    cdp.emit('Page.screencastFrame', jpegFrame(3, 32));
    await until(() => client.frames.some((f) => f.t === 'frame'), 'a frame after the restart');
    expect(lane.laneCount).toBe(1);
    client.ws.close();
  });

  it('clamps absurd frame metadata to sane dimensions before the pointer maths', async () => {
    const client = await ready();
    cdp.emit('Page.screencastFrame', {
      data: Buffer.alloc(32, 0x41).toString('base64'),
      sessionId: 3,
      // Finite, so the frame is usable — but no device reports these, and
      // `offsetTop` is the one that reaches `mouseParams` as a subtraction.
      metadata: {
        deviceWidth: 1e12,
        deviceHeight: 1e12,
        offsetTop: Number.NaN,
        scrollOffsetX: Number.POSITIVE_INFINITY,
        scrollOffsetY: -1e12,
      },
    });
    await until(() => client.frames.some((f) => f.t === 'frame'), 'the clamped frame');

    client.send({ t: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left' });
    await until(() => cdp.paramsFor('Input.dispatchMouseEvent') !== undefined, 'mouse dispatch');
    const params = cdp.paramsFor('Input.dispatchMouseEvent');
    // Clamped to the ceiling, and `offsetTop` fell back to 0 rather than NaN.
    expect(params).toMatchObject({
      x: MAX_TAKEOVER_PAGE_DIMENSION,
      y: MAX_TAKEOVER_PAGE_DIMENSION,
    });
    expect(Number.isFinite(params?.x)).toBe(true);
    expect(Number.isFinite(params?.y)).toBe(true);
    client.ws.close();
  });

  it('still accepts the largest legitimate client frames — the bound is not too tight', async () => {
    const longSession = 's'.repeat(MAX_TAKEOVER_ID_CHARS);
    const longRequest = 'r'.repeat(MAX_TAKEOVER_ID_CHARS);
    target.takeover = { requestId: longRequest };
    find = (id) => (id === longSession ? target : null);

    const client = open();
    await client.opened;
    client.send({ t: 'hello', sessionId: longSession, requestId: longRequest });
    await until(() => client.frames.some((f) => f.t === 'ready'), 'ready frame');

    // ...and the largest `key` frame the schema admits still dispatches.
    client.send({
      t: 'key',
      type: 'keyDown',
      key: 'k'.repeat(32),
      code: 'c'.repeat(32),
      text: 't'.repeat(8),
      keyCode: 255,
      modifiers: 15,
    });
    await until(
      () => cdp.paramsFor('Input.dispatchKeyEvent') !== undefined,
      'the largest key frame dispatching',
    );
    client.ws.close();
  });
});
