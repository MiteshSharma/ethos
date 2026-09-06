import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '@ethosagent/types';
import {
  BROWSER_TAKEOVER_SOCKET_PATH,
  BROWSER_TAKEOVER_VERSION,
  type BrowserTakeoverClientFrame,
  type BrowserTakeoverServerFrame,
  decodeBrowserTakeoverClientFrame,
  encodeBrowserTakeoverFrame,
  MAX_TAKEOVER_CLIENT_FRAME_BYTES,
  MAX_TAKEOVER_FRAME_BYTES,
  TAKEOVER_SCREENCAST,
} from '@ethosagent/web-contracts';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  refuseUpgrade,
  registerUpgradeRoute,
  type UpgradableServer,
} from '../voice/upgrade-router';
import { originAllowed } from '../voice/voice-socket';

// The screencast half of a browser takeover (plan B3, T8).
//
// `browser_request_takeover` parks the agent on a clarify and locks its
// browser session. On a desktop the human uses the real window. On a headless
// VPS there is no window, so this lane IS the window: CDP `Page.startScreencast`
// frames down, `Input.dispatch*` up, and one `handback` frame that resolves the
// clarify the agent is waiting on.
//
// THE HONEST BOUNDARY, and the reason `sessions` is INJECTED rather than
// imported: this can only drive a browser session that lives in THIS process.
// A turn hosted by `ethos gateway` opened its Chromium over there, and no
// amount of socket plumbing in web-api reaches it. So the registry is a lookup
// the composition root supplies, absent by default, and a lane opened for a
// session this process cannot see is REFUSED with `session_unavailable` and a
// sentence saying so. The failure a blank canvas would produce — a person
// staring at nothing, believing they are driving a browser — is worse than the
// refusal by a wide margin.
//
// Upgrade posture is the voice lane's, reused verbatim: `noServer: true` plus
// `registerUpgradeRoute` (one `upgrade` listener per server, dispatching by
// path), `originAllowed` for the DNS-rebinding gate, and an injected
// `authenticate` for the session cookie. What is NOT reused is the per-request
// lane and the eviction map: `createVoiceSocket` hardcodes `VoiceLane`,
// `RealtimeControlLane` and `encodeVoiceFrame`, so there is nothing to import.
// The eviction SHAPE below is the same, and the same reasoning holds for it —
// see the comment on `holders`.

/** The subset of a Playwright `Page` this lane touches. */
export interface TakeoverPage {
  url(): string;
  isClosed(): boolean;
}

/**
 * The subset of a Playwright `CDPSession` this lane touches. Structural on
 * purpose: `apps/web-api` does not depend on `playwright`, and it should not —
 * the composition root that owns the browser hands one of these in.
 */
export interface TakeoverCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
  detach(): Promise<void>;
}

/**
 * One browser session under takeover, as this lane needs it.
 *
 * `newCDPSession` is a closure rather than the `BrowserContext` itself so the
 * one Playwright-shaped call (`context.newCDPSession(page)`) stays at the
 * composition root and this file stays dependency-free.
 */
export interface TakeoverTarget {
  page: TakeoverPage;
  newCDPSession(): Promise<TakeoverCdpSession>;
  /**
   * Set while the agent is parked, and naming the clarify it is parked on.
   * Absent → nobody handed this browser over.
   *
   * READ THROUGH A GETTER by the registry, never snapshotted: this lane
   * re-reads it before every input and every frame, and a copy taken at
   * `hello` would report a lock released minutes ago as still held.
   */
  takeover?: { requestId?: string } | undefined;
}

/**
 * Where the socket finds a session. THE TOOL'S LOCK REGISTRY, not a policy
 * re-lookup: `getOrCreateSession` keys on (sessionId, networkPolicy) and tears
 * a session down and replaces it when the fingerprint changes, so a re-lookup
 * can hand back a DIFFERENT browser than the one the agent locked — the exact
 * bug `browser_request_takeover` captures a session reference to avoid.
 */
export interface TakeoverSessionRegistry {
  find(sessionId: string): TakeoverTarget | null;
  /**
   * Watch for takeovers ending — `(sessionId, requestId)` of the one that
   * settled — and return an unsubscribe.
   *
   * A takeover ends in four places this socket cannot see: the chat card, the
   * clarify timeout, a cancelled turn, and this lane's own hand-back. Without
   * a push, the lane only learns on the viewer's NEXT frame, so a person who
   * has stopped typing keeps a live CDP session on a browser the agent has
   * already resumed driving. Optional so a bare registry (a test, a deployment
   * with no tool-side registry) still works — the per-frame revalidation is
   * the floor, this is what makes it timely.
   */
  onSettled?(listener: (sessionId: string, requestId: string) => void): () => void;
}

/**
 * What a hand-back attempt DID — the evidence `closed: handed_back` is sent on.
 *
 * A discriminated result rather than `Promise<void>` because "resolved without
 * throwing" is not evidence of anything here. `ClarifyBridge.respond()` used to
 * return `void` and swallow every request it could not resolve — an id it has
 * never heard of, a takeover its answer gate refuses, a row a peer process
 * already answered — so all of them reached the caller looking exactly like
 * success. Four times now this feature has reported a hand-back nothing
 * performed; a shape with no "it worked" value to default to is what stops a
 * fifth.
 *
 * `reason` is a sentence for the viewer, not a code: it is interpolated into
 * `handback_failed` and read by the person who pressed the button.
 */
export type TakeoverHandbackResult = { resolved: true } | { resolved: false; reason: string };

/**
 * Resolve the clarify the agent is parked on, and REPORT WHETHER IT DID.
 *
 * Bound in production to `ClarifyBridge.respond` (see the `handback` option
 * assembled in `apps/web-api/src/index.ts`), whose own
 * `ClarifyRespondOutcome` supplies `resolved` and the sentence for `reason`.
 * The adapter is thin on purpose: it exists to turn a machine-readable reason
 * into viewer copy, not to decide the outcome.
 */
export type TakeoverHandback = (requestId: string) => Promise<TakeoverHandbackResult>;

export interface TakeoverSocketOptions {
  /**
   * Browser sessions reachable from this process. Absent → every lane is
   * refused with `session_unavailable`, which is the honest answer for a
   * deployment whose browsing happens in the gateway process.
   */
  sessions?: TakeoverSessionRegistry;
  /**
   * Resolve the clarify on hand-back. REQUIRED, and required for a reason.
   *
   * `closed: handed_back` is a claim about the AGENT — the request it is
   * parked on has been answered and the browser is its own again. A lane with
   * no way to resolve the clarify cannot make that claim truthfully, and while
   * this was optional an absent callback made it anyway: the operator was told
   * control was returned while the agent stayed parked. That is the third time
   * this feature has reported a hand-back nothing performed, so the shape is
   * gone rather than guarded — with no "nothing to call" branch, there is no
   * path from an absent capability to a success frame.
   *
   * A deployment that genuinely cannot hand back (web-api built without a
   * `ClarifyBridge`) supplies one that reports `resolved: false`. The viewer
   * then gets `handback_failed` with the reason and the takeover stays live,
   * which is loud exactly where the absent callback was silent.
   */
  handback: TakeoverHandback;
  /** Credential check for the upgrade request. Rejected → 401, no socket. */
  authenticate(req: IncomingMessage): Promise<boolean>;
  /** Extra Origins allowed beyond loopback. Same rule as the HTTP surface. */
  allowedOrigins?: string[];
  path?: string;
  logger?: Logger;
}

export interface TakeoverSocket {
  /** Serve this lane's path on a listening server's upgrade router. */
  attach(server: UpgradableServer): void;
  /** Live lane count — one per connected takeover viewer. */
  readonly laneCount: number;
  close(): Promise<void>;
}

/** Everything one connected viewer owns. */
interface Lane {
  socket: WebSocket;
  /** Eviction key — the BOUND identity `sessionId + requestId`, from `hello`. */
  key: string | null;
  /** The browser session this lane is driving, from `hello`. */
  sessionId: string | null;
  /** The clarify a `handback` resolves, from `hello`. Bound to the lock. */
  requestId: string | null;
  /** True from the moment a hand-back starts resolving, so the settle
   *  notification it triggers does not close this lane out from under its own
   *  `handed_back` frame. Cleared again if the hand-back FAILS. */
  settling: boolean;
  /**
   * This lane is over, set SYNCHRONOUSLY the moment it ends — evicted by a
   * second tab, or closed because the takeover settled.
   *
   * `socket.close()` only starts a closing handshake: frames the evicted
   * client already put on the wire keep arriving at the message handler for as
   * long as it takes to finish, and a lane whose CDP session is still attached
   * would dispatch them. This is the flag those frames fail closed against, and
   * it also stops an in-flight `hello` from wiring a screencast onto a lane
   * that was evicted while its CDP session was still opening — a window
   * `teardown` alone cannot cover, because it runs before that session exists.
   */
  revoked: boolean;
  /** The session this lane is driving. Null until `hello` resolves one. */
  target: TakeoverTarget | null;
  cdp: TakeoverCdpSession | null;
  /** Detaches the `Page.screencastFrame` listener. */
  stop: (() => void) | null;
  /** Page dimensions CDP reported for the newest frame, for pointer scaling. */
  pageWidth: number;
  pageHeight: number;
  /** Offsets CDP reported for the newest frame, for pointer scaling. */
  offsetTop: number;
  /** Newest URL already reported to the viewer, so a `url` frame is sent once
   *  per navigation rather than once per screencast frame. */
  lastUrl: string;
  scrollX: number;
  scrollY: number;
}

const send = (socket: WebSocket, frame: BrowserTakeoverServerFrame, payload?: Uint8Array): void => {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(encodeBrowserTakeoverFrame(frame, payload), { binary: true });
};

/** The bounded screencast, in one place — `hello` starts it, a failed
 *  hand-back restarts it rather than leaving the viewer a frozen picture. */
const startScreencast = (cdp: TakeoverCdpSession): Promise<unknown> =>
  cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: TAKEOVER_SCREENCAST.quality,
    maxWidth: TAKEOVER_SCREENCAST.maxWidth,
    maxHeight: TAKEOVER_SCREENCAST.maxHeight,
    everyNthFrame: 1,
  });

/**
 * Is this lane still driving the takeover it was bound to at `hello`?
 *
 * Re-read, never cached. The lock is cleared by `browser_request_takeover`'s
 * `finally` on EVERY exit — chat-card hand-back, timeout, cancelled turn — and
 * the registry hands `takeover` back through a getter precisely so this sees
 * it. False means the human and the resumed agent would otherwise be driving
 * the same page.
 */
const stillBound = (lane: Lane): boolean => {
  const target = lane.target;
  if (!target || !lane.requestId) return false;
  if (target.takeover?.requestId !== lane.requestId) return false;
  return !target.page.isClosed();
};

export function createTakeoverSocket(opts: TakeoverSocketOptions): TakeoverSocket {
  const path = opts.path ?? BROWSER_TAKEOVER_SOCKET_PATH;
  // `maxPayload` is the wire-level half of this lane's size posture, and the
  // half `MAX_TAKEOVER_FRAME_BYTES` does not cover: that one bounds the JPEGs
  // going DOWN, this one bounds what an authenticated client can make the
  // process allocate coming UP. Every client frame here is a tiny JSON header
  // with an empty payload, so the library's multi-megabyte default is four
  // orders of magnitude of headroom nothing on this lane needs. Over the bound,
  // `ws` fails the connection with a 1009 before a byte reaches this file.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TAKEOVER_CLIENT_FRAME_BYTES,
  });
  const lanes = new Map<WebSocket, Lane>();

  // A second tab on the same takeover is a TAKEOVER of the lane, not a second
  // driver: two viewers dispatching pointer events into one page is not
  // "collaborative", it is a page neither of them can predict. Same plain-Map
  // shape and same reasoning as the voice lane's `holders`: `claim` is fully
  // synchronous, JS is single-threaded, so the read and the write inside one
  // call can never interleave with another connection's — the map is always
  // atomically consistent, and a third and fourth connection just cascade the
  // same eviction. It is reimplemented rather than imported because the voice
  // lane's copy is welded to `VoiceLane` and `encodeVoiceFrame`; extracting it
  // would mean editing a live surface for no behavioural gain.
  //
  // Keyed on the BOUND identity (session AND request), not the session alone:
  // a lane left over from a PREVIOUS takeover of the same browser is not the
  // same conversation, and it is closed by the settle notification rather than
  // silently inherited by whoever opens the next one.
  const holders = new Map<string, WebSocket>();

  const teardown = (socket: WebSocket): void => {
    const lane = lanes.get(socket);
    if (!lane) return;
    lane.revoked = true;
    lane.stop?.();
    void lane.cdp?.detach().catch(() => undefined);
    lane.cdp = null;
    lanes.delete(socket);
    // Only release the key while `holders` still names THIS socket — an evicted
    // lane's own teardown must not free the key its evictor just claimed.
    if (lane.key && holders.get(lane.key) === socket) holders.delete(lane.key);
  };

  /**
   * End a lane the viewer did not end: the takeover it was bound to is over.
   * The screencast is stopped first — CDP keeps producing frames for a session
   * nobody is draining otherwise — then the lane is torn down and the socket
   * closed, so the CDP session cannot outlive the lock that justified it.
   */
  const endLane = (live: Lane, reason: 'session_gone' | 'taken_over'): void => {
    // Revoked BEFORE anything else, including the frame that announces it: a
    // lane that is over must fail closed from this statement onward, not from
    // whenever its close handshake completes.
    live.revoked = true;
    void live.cdp?.send('Page.stopScreencast').catch(() => undefined);
    send(live.socket, { t: 'closed', reason });
    teardown(live.socket);
    live.socket.close();
  };

  // The push half of the revalidation (the pull half is `stillBound`, checked
  // on every input and every frame). Without this, a viewer who has stopped
  // typing keeps its CDP session for as long as the tab stays open.
  const unsubscribeSettled =
    opts.sessions?.onSettled?.((sessionId, requestId) => {
      for (const live of [...lanes.values()]) {
        // A lane resolving its OWN hand-back is mid-`handed_back`; closing it
        // here would replace that answer with `session_gone`.
        if (live.settling) continue;
        if (live.sessionId !== sessionId || live.requestId !== requestId) continue;
        endLane(live, 'session_gone');
      }
    }) ?? null;

  const onConnection = (socket: WebSocket): void => {
    const lane: Lane = {
      socket,
      key: null,
      sessionId: null,
      requestId: null,
      settling: false,
      revoked: false,
      target: null,
      cdp: null,
      stop: null,
      lastUrl: '',
      pageWidth: 0,
      pageHeight: 0,
      offsetTop: 0,
      scrollX: 0,
      scrollY: 0,
    };
    lanes.set(socket, lane);

    const fail = (
      code: Extract<BrowserTakeoverServerFrame, { t: 'error' }>['code'],
      message: string,
    ): void => {
      send(socket, { t: 'error', code, message });
      socket.close();
    };

    const hello = async (frame: Extract<BrowserTakeoverClientFrame, { t: 'hello' }>) => {
      if (lane.key) return; // one `hello` per lane
      const target = opts.sessions?.find(frame.sessionId);
      if (!target) {
        // The honest refusal. NOT a blank canvas: this process has no browser
        // by that name, which for a gateway-hosted turn is the permanent truth,
        // not a transient one.
        fail(
          'session_unavailable',
          `This Ethos process has no browser session "${frame.sessionId}". A takeover started by a gateway-hosted turn can only be handed back from the chat card, not driven from here.`,
        );
        return;
      }
      if (!target.takeover) {
        fail('not_in_takeover', 'That browser session is not handed over to a human right now.');
        return;
      }
      // The lane is bound to ONE clarify, and the client does not get to name
      // it. A takeover the agent locked carries the request id it is parked on
      // (`onRequestId`); an authenticated client presenting any other id would
      // otherwise drive this browser while a `handback` resolved somebody
      // else's question. A lock with no id at all is one nothing can be handed
      // back through, so it is refused by the same comparison.
      if (target.takeover.requestId !== frame.requestId) {
        fail(
          'not_in_takeover',
          'That is not the request this browser session is parked on — hand back from the chat card instead.',
        );
        return;
      }
      if (target.page.isClosed()) {
        fail('session_unavailable', 'That browser session has already closed.');
        return;
      }

      const key = `${frame.sessionId}\x00${frame.requestId}`;
      const existing = holders.get(key);
      if (existing && existing !== socket) {
        // Evicting is not "ask the other socket to go away" — `close()` only
        // schedules a handshake, and until it lands the evicted lane still has
        // its CDP session and still passes `stillBound`, so its already-queued
        // mouse and key frames dispatch into the same page this one is about to
        // drive. Two authorized drivers is the exact condition `holders` exists
        // to prevent, so the old lane is ENDED here — revoked, screencast
        // stopped, CDP detached, lane dropped — synchronously, and before the
        // new holder is recorded.
        const evicted = lanes.get(existing);
        if (evicted) endLane(evicted, 'taken_over');
        else existing.close();
      }
      holders.set(key, socket);
      lane.key = key;
      lane.sessionId = frame.sessionId;
      lane.requestId = frame.requestId;
      // Bound BEFORE the screencast starts: `onFrame` revalidates against
      // `lane.target`, and a frame can land the moment the listener attaches.
      lane.target = target;

      try {
        const cdp = await target.newCDPSession();
        // Evicted while the session was opening. `teardown` ran before this
        // session existed, so nothing else will ever detach it — and wiring it
        // up now would hand a revoked lane a live screencast.
        if (lane.revoked) {
          void cdp.detach().catch(() => undefined);
          return;
        }
        lane.cdp = cdp;
        const onFrame = (payload: unknown): void => {
          // Frames are an operation on the takeover too: pixels of a page the
          // agent has resumed driving are a picture of somebody else's work.
          if (!stillBound(lane)) {
            endLane(lane, 'session_gone');
            return;
          }
          handleScreencastFrame(lane, payload);
        };
        cdp.on('Page.screencastFrame', onFrame);
        lane.stop = () => cdp.off('Page.screencastFrame', onFrame);
        await cdp.send('Page.enable');
        // Evicted mid-handshake: `teardown` has already detached this session,
        // and starting a screencast on it now would be pixels for a lane that
        // is over.
        if (lane.revoked) return;
        await startScreencast(cdp);
      } catch (err) {
        opts.logger?.warn?.('browser takeover screencast failed to start', {
          error: err instanceof Error ? err.message : String(err),
        });
        fail(
          'screencast_failed',
          'Could not start the screencast on that browser. Hand back from the chat card instead.',
        );
        return;
      }

      if (lane.revoked) return;
      lane.lastUrl = target.page.url();
      send(socket, {
        t: 'ready',
        url: lane.lastUrl,
        protocolVersion: BROWSER_TAKEOVER_VERSION,
      });
    };

    socket.on('message', (data: unknown, isBinary: boolean) => {
      // A revoked lane dispatches nothing. This is the belt to `endLane`'s
      // braces: the lane was torn down synchronously, but the socket's close
      // is not synchronous, so frames the evicted client had already sent are
      // still delivered here afterwards.
      if (lane.revoked) return;
      if (!isBinary) return;
      const bytes = toBytes(data);
      if (!bytes) return;
      const decoded = decodeBrowserTakeoverClientFrame(bytes);
      if (!decoded) {
        send(socket, {
          t: 'error',
          code: 'bad_frame',
          message: 'Unrecognized takeover frame — ignored.',
        });
        return;
      }
      const frame = decoded.header;
      if (frame.t === 'hello') {
        void hello(frame);
        return;
      }
      // Everything below needs a live lane. A frame that arrives before
      // `hello` (or after the lane was evicted) is dropped, not guessed at.
      const cdp = lane.cdp;
      if (!cdp) return;
      // ...and a lane still bound to the takeover it opened on. `hello` is not
      // the only place this can change: the chat card, the clarify timeout and
      // a cancelled turn all clear the lock while this socket sits open with a
      // CDP session in hand. Checked before EVERY input, not once, because the
      // failure is a human and the resumed agent typing into the same page.
      if (!stillBound(lane)) {
        endLane(lane, 'session_gone');
        return;
      }
      if (frame.t === 'ack') {
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.seq }).catch(() => undefined);
        return;
      }
      if (frame.t === 'mouse') {
        void cdp.send('Input.dispatchMouseEvent', mouseParams(lane, frame)).catch(() => undefined);
        return;
      }
      if (frame.t === 'key') {
        void cdp.send('Input.dispatchKeyEvent', keyParams(frame)).catch(() => undefined);
        return;
      }
      // handback
      void handBack(lane);
    });

    /**
     * Resolve the clarify, then say so — in that order, and only on evidence.
     *
     * `handed_back` is a claim about the AGENT, not about this socket: it says
     * the request the agent is parked on has been answered and the browser is
     * its own again. A missing, expired, cancelled or already-settled request
     * does NOT make `ClarifyBridge.respond` throw — it used to return `void`
     * and swallow all four — so the guarantee this comment used to assert was
     * enforced by nothing, and reporting those as a hand-back told the viewer
     * they were done while the agent stayed parked or settled some other way.
     *
     * What enforces it now is the RESULT TYPE: `opts.handback` returns
     * `TakeoverHandbackResult`, and the `handed_back` frame below sits behind
     * `result.resolved`. There is no branch that skips the call and falls
     * through to it, no absent-callback branch (`handback` is required), and
     * no value the call can return that means "it worked" by default. A
     * failure keeps the takeover LIVE — screencast restarted, lane open — and
     * says what went wrong, leaving the retry to the human, here or on the
     * chat card. The tool holds the same line: it reports `handed_back` from
     * `response.source === 'user'`, never from "nothing threw".
     *
     * This also covers the two awaits below, which is why nothing re-reads
     * `stillBound` between them: a takeover that settles during
     * `Page.stopScreencast` (a 15-minute timeout expiring, an aborted turn,
     * the chat card) leaves `respond` nothing to resolve, so the evidence is
     * absent and the lane refuses rather than announcing a hand-back somebody
     * else's settlement performed. `refuse` then decides between "still yours,
     * try again" and `session_gone` by asking `stillBound` once, at the only
     * moment the answer matters.
     */
    const handBack = async (live: Lane): Promise<void> => {
      if (live.settling) return;
      live.settling = true;
      // Stop the pixels BEFORE resolving: the agent resumes the moment the
      // clarify settles, and a screencast still running into a socket that is
      // about to close is frames nobody draws.
      await live.cdp?.send('Page.stopScreencast').catch(() => undefined);
      // Every way this can fail lands here, and there are two of them.
      //
      // The takeover is still live → it is STILL THIS OPERATOR'S: the
      // screencast stopped above is started again and the lane stays open for
      // the retry the message invites.
      //
      // The takeover is NOT still live → something else settled it while this
      // hand-back was in flight (the settle push is muted for a settling lane,
      // `:onSettled`, so this is the only place that learns). Restarting the
      // screencast would stream a page the agent has resumed driving to a
      // person invited to click on it, and "try again" would be advice with
      // nothing left to try. The lane ends as `session_gone` instead.
      const refuse = async (detail: string): Promise<void> => {
        live.settling = false;
        if (!stillBound(live)) {
          endLane(live, 'session_gone');
          return;
        }
        if (live.cdp) await startScreencast(live.cdp).catch(() => undefined);
        send(live.socket, {
          t: 'error',
          code: 'handback_failed',
          message: `The hand-back did not go through: ${detail}. The browser is still yours — try again, or hand back from the chat card.`,
        });
      };
      const requestId = live.requestId;
      if (!requestId) {
        await refuse('this lane is not bound to a takeover request');
        return;
      }
      let result: TakeoverHandbackResult;
      try {
        result = await opts.handback(requestId);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.('browser takeover hand-back failed', { error: detail });
        await refuse(detail);
        return;
      }
      if (!result.resolved) {
        opts.logger?.warn?.('browser takeover hand-back resolved nothing', {
          reason: result.reason,
        });
        await refuse(result.reason);
        return;
      }
      live.stop?.();
      live.stop = null;
      send(live.socket, { t: 'closed', reason: 'handed_back' });
      live.socket.close();
    };

    socket.on('close', () => teardown(socket));
    socket.on('error', () => teardown(socket));
  };

  wss.on('connection', onConnection);

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    opts
      .authenticate(req)
      .then((ok) => {
        if (!ok) {
          refuseUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      })
      .catch(() => refuseUpgrade(socket, 401, 'Unauthorized'));
  };

  let detach: (() => void) | null = null;

  return {
    attach(server: UpgradableServer): void {
      detach?.();
      detach = registerUpgradeRoute(server, path, handleUpgrade);
    },
    get laneCount(): number {
      return lanes.size;
    },
    close(): Promise<void> {
      detach?.();
      detach = null;
      unsubscribeSettled?.();
      for (const socket of [...lanes.keys()]) {
        teardown(socket);
        socket.close();
      }
      lanes.clear();
      holders.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Screencast frames — where this lane's size posture lives
// ---------------------------------------------------------------------------

/**
 * The longest base64 string a permitted frame can arrive as.
 *
 * Base64 encodes 3 bytes as 4 characters, padding a final partial group out to
 * four, so `MAX_TAKEOVER_FRAME_BYTES` of JPEG is at most `ceil(bytes / 3) * 4`
 * characters. Checking the STRING against this BEFORE `Buffer.from` is what
 * makes the cap a bound on the ALLOCATION rather than only on what is written
 * to the socket: these frames come from Chromium rendering whatever page the
 * agent was sent to, and decoding one to find out how big it is has already
 * spent the heap the cap exists to protect.
 *
 * Derived from the byte cap rather than written as a literal so the two cannot
 * drift, and rounded the generous way: a string exactly at this length decodes
 * to at most one byte over the cap, because how much padding it carries is not
 * known until it is read. That byte is why the decoded length is checked again
 * afterwards, and rounding the other way would reject the largest frame the
 * cap is supposed to admit.
 */
export const MAX_TAKEOVER_FRAME_BASE64_CHARS = Math.ceil(MAX_TAKEOVER_FRAME_BYTES / 3) * 4;

/**
 * Ceiling on any dimension or offset a frame's metadata may report.
 *
 * Chromium's own window and document limits sit orders of magnitude below
 * this. The number exists to keep a value that is not a real dimension out of
 * the pointer maths, not to second-guess a real one.
 */
export const MAX_TAKEOVER_PAGE_DIMENSION = 100_000;

/**
 * One metadata offset, or 0 when the page reported something that is not a
 * usable number. `NaN` and `Infinity` are the interesting cases: both survive
 * a `typeof === 'number'` test and both turn a click into coordinates CDP
 * cannot dispatch, so neither may reach `mouseParams`.
 */
function clampMetric(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, min), max);
}

/**
 * CDP's `Page.screencastFrame`. Parsed defensively rather than cast: it is the
 * one payload on this lane that arrives from outside the type system, and a
 * malformed one must drop a frame, not kill the takeover.
 */
interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    offsetTop?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
  };
}

/**
 * The one field an ack needs, read WITHOUT the rest of the frame.
 *
 * `Page.screencastFrameAck` takes a session id and nothing else, and a payload
 * can carry a perfectly good one while the rest of it is unusable — a
 * `deviceWidth` that is not a number, a missing `data`. Reading it separately
 * is what lets a malformed frame be DROPPED instead of WEDGING the lane: CDP
 * emits nothing further until the previous frame is acked, so a frame that
 * returns without one does not slow the stream, it ends it.
 *
 * Non-finite and negative are refused here rather than passed through: neither
 * is a session id CDP mints, `Page.screencastFrame`'s own `seq` is declared
 * non-negative on the wire, and acking `NaN` is not an ack.
 */
function readAckSessionId(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const sessionId = (payload as Record<string, unknown>).sessionId;
  if (typeof sessionId !== 'number' || !Number.isFinite(sessionId) || sessionId < 0) return null;
  return sessionId;
}

function readScreencastFrame(payload: unknown): ScreencastFrame | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const data = record.data;
  const sessionId = readAckSessionId(payload);
  const metadata = record.metadata;
  if (typeof data !== 'string' || sessionId === null) return null;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;
  const deviceWidth = meta.deviceWidth;
  const deviceHeight = meta.deviceHeight;
  if (typeof deviceWidth !== 'number' || typeof deviceHeight !== 'number') return null;
  // Dimensions are required and scale every pointer event, so a value that is
  // not a real one drops the frame rather than being clamped: substituting a
  // size would put the human's clicks somewhere the page never drew, which is
  // worse than the one repaint a dropped frame costs. `NaN` and a negative
  // both fail `> 0`; `Infinity` needs the finite test to fail with them.
  if (!Number.isFinite(deviceWidth) || !Number.isFinite(deviceHeight)) return null;
  if (!(deviceWidth > 0) || !(deviceHeight > 0)) return null;
  return {
    data,
    sessionId,
    // Finite but absurd IS clamped — the offsets have an honest default (0),
    // and a dimension past `MAX_TAKEOVER_PAGE_DIMENSION` is a number no device
    // reports, so the cap costs a real page nothing.
    metadata: {
      deviceWidth: Math.min(deviceWidth, MAX_TAKEOVER_PAGE_DIMENSION),
      deviceHeight: Math.min(deviceHeight, MAX_TAKEOVER_PAGE_DIMENSION),
      offsetTop: clampMetric(meta.offsetTop, 0, MAX_TAKEOVER_PAGE_DIMENSION),
      scrollOffsetX: clampMetric(
        meta.scrollOffsetX,
        -MAX_TAKEOVER_PAGE_DIMENSION,
        MAX_TAKEOVER_PAGE_DIMENSION,
      ),
      scrollOffsetY: clampMetric(
        meta.scrollOffsetY,
        -MAX_TAKEOVER_PAGE_DIMENSION,
        MAX_TAKEOVER_PAGE_DIMENSION,
      ),
    },
  };
}

/**
 * Ship one frame, or drop it — and ACK either way.
 *
 * Two bounds, because `frame-codec.ts` caps the HEADER (64 KiB) and says
 * nothing about the payload, which here is a JPEG of an arbitrary page:
 *
 *  1. A frame over `MAX_TAKEOVER_FRAME_BYTES` is dropped, and dropped on its
 *     ENCODED length first (`MAX_TAKEOVER_FRAME_BASE64_CHARS`) so an oversized
 *     one is never decoded. Deciding after `Buffer.from` would bound what
 *     reaches the socket while leaving the allocation itself unbounded, which
 *     is the half that actually costs the process its heap. The decoded length
 *     is then checked as well, for the byte the character bound rounds away.
 *     The dimension and quality caps handed to `Page.startScreencast` keep the
 *     normal case far under it; this is the tail — a full-bleed photograph
 *     repainting — and shipping it would cost the socket seconds of
 *     head-of-line latency for one frame nobody needs at full fidelity.
 *  2. A frame that would queue behind an already-backed-up socket is dropped.
 *     `bufferedAmount` is the honest measure of a viewer that cannot keep up;
 *     the alternative is an unbounded queue of stale pixels, which is worse
 *     than a lower frame rate in every way that matters here.
 *
 * The ack is unconditional because CDP emits nothing further until it lands:
 * a dropped frame that is not acked does not slow the stream down, it ENDS it.
 * That includes a frame this file cannot READ. The ack needs only the session
 * id, and a payload can carry a valid one while its metadata is unusable, so a
 * malformed frame is acked on that id and its pixels dropped. When even the
 * session id is unusable there is nothing to ack against, and the only other
 * way out of the wedge is to stop the screencast and start it again — which is
 * what happens, rather than leaving the lane a still picture for the rest of
 * the takeover.
 */
function handleScreencastFrame(lane: Lane, payload: unknown): void {
  const cdp = lane.cdp;
  if (!cdp) return;
  const ack = (sessionId: number): void => {
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  };
  const parsed = readScreencastFrame(payload);
  if (!parsed) {
    const sessionId = readAckSessionId(payload);
    if (sessionId !== null) {
      ack(sessionId);
      return;
    }
    void cdp
      .send('Page.stopScreencast')
      .catch(() => undefined)
      .then(() => startScreencast(cdp))
      .catch(() => undefined);
    return;
  }

  lane.pageWidth = parsed.metadata.deviceWidth;
  lane.pageHeight = parsed.metadata.deviceHeight;
  lane.offsetTop = parsed.metadata.offsetTop ?? 0;
  lane.scrollX = parsed.metadata.scrollOffsetX ?? 0;
  lane.scrollY = parsed.metadata.scrollOffsetY ?? 0;

  // The side column's URL follows the page. Read off the session rather than
  // a second CDP subscription: a navigation is only interesting to the viewer
  // once it has REPAINTED, and a repaint is exactly what this handler is.
  const url = lane.target?.page.url() ?? lane.lastUrl;
  if (url !== lane.lastUrl) {
    lane.lastUrl = url;
    send(lane.socket, { t: 'url', url });
  }

  if (parsed.data.length > MAX_TAKEOVER_FRAME_BASE64_CHARS) {
    ack(parsed.sessionId);
    return;
  }
  if (lane.socket.bufferedAmount > MAX_TAKEOVER_FRAME_BYTES) {
    ack(parsed.sessionId);
    return;
  }
  const bytes = Buffer.from(parsed.data, 'base64');
  // Exact, now that the bytes exist: the character bound admits a string whose
  // padding leaves it a byte over the cap.
  if (bytes.byteLength > MAX_TAKEOVER_FRAME_BYTES) {
    ack(parsed.sessionId);
    return;
  }
  send(
    lane.socket,
    {
      t: 'frame',
      seq: parsed.sessionId,
      width: parsed.metadata.deviceWidth,
      height: parsed.metadata.deviceHeight,
    },
    new Uint8Array(bytes),
  );
  // NOT acked here: the client acks when it has painted (`ack` frame), which
  // is what keeps CDP from producing frames faster than a viewer draws them.
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Pointer coordinates arrive as a FRACTION of the image (0-1), so the viewer
 * can render the screencast at any size without knowing the page's own
 * dimensions. They are scaled here against the metadata CDP reported for the
 * newest frame, plus the scroll offsets — `Input.dispatchMouseEvent` wants
 * viewport coordinates, which is what `offsetTop` corrects for.
 */
function mouseParams(
  lane: Lane,
  frame: Extract<BrowserTakeoverClientFrame, { t: 'mouse' }>,
): Record<string, unknown> {
  const width = lane.pageWidth > 0 ? lane.pageWidth : 0;
  const height = lane.pageHeight > 0 ? lane.pageHeight : 0;
  return {
    type: frame.type,
    x: Math.round(frame.x * width),
    y: Math.round(frame.y * height) - lane.offsetTop,
    button: frame.button ?? 'none',
    clickCount: frame.clickCount ?? 0,
    modifiers: frame.modifiers ?? 0,
    ...(frame.type === 'mouseWheel'
      ? { deltaX: frame.deltaX ?? 0, deltaY: frame.deltaY ?? 0 }
      : {}),
  };
}

function keyParams(
  frame: Extract<BrowserTakeoverClientFrame, { t: 'key' }>,
): Record<string, unknown> {
  return {
    type: frame.type,
    modifiers: frame.modifiers ?? 0,
    ...(frame.key !== undefined ? { key: frame.key } : {}),
    ...(frame.code !== undefined ? { code: frame.code } : {}),
    ...(frame.text !== undefined ? { text: frame.text } : {}),
    ...(frame.keyCode !== undefined
      ? { windowsVirtualKeyCode: frame.keyCode, nativeVirtualKeyCode: frame.keyCode }
      : {}),
  };
}

/**
 * `ws` hands a Buffer, an array of Buffers, or an ArrayBuffer depending on
 * config. Bounded on every path by `MAX_TAKEOVER_CLIENT_FRAME_BYTES`, the size
 * of the largest frame this lane's client schemas can produce.
 *
 * The FRAGMENTED case is why the bound is repeated here rather than left to
 * `maxPayload`: this concatenates the parts into one buffer, and summing their
 * lengths first means an over-long message is refused BEFORE that allocation
 * rather than after it. Decoding never sees an oversized frame either way.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data.length > MAX_TAKEOVER_CLIENT_FRAME_BYTES ? null : data;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength > MAX_TAKEOVER_CLIENT_FRAME_BYTES ? null : new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    const parts = data.filter((part): part is Uint8Array => part instanceof Uint8Array);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total > MAX_TAKEOVER_CLIENT_FRAME_BYTES) return null;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  return null;
}
