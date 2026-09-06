import {
  BROWSER_TAKEOVER_SOCKET_PATH,
  type BrowserTakeoverClientFrame,
  decodeBrowserTakeoverServerFrame,
  encodeBrowserTakeoverFrame,
} from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TAKEOVER_MIN_WIDTH, type TakeoverStageStatus } from './TakeoverStage';

// The browser half of the screencast takeover lane.
//
// Kept out of `TakeoverStage.tsx` for the same reason `call-motion.ts` is kept
// out of `CallStage.tsx`: the component is then a pure render of props and can
// be asserted with `renderToStaticMarkup`, and the socket is the only thing
// that needs a live DOM.
//
// Two things this hook owns that are easy to get wrong:
//
//  1. ACKING. CDP produces no further frame until `Page.screencastFrameAck`,
//     so a viewer that forgets to ack sees exactly one frame and a still
//     picture that looks like a hung page. The ack goes out as soon as the
//     frame has been turned into an object URL — that IS "painted enough".
//  2. REVOKING. Every frame is an object URL; at ~10fps a lane that never
//     revokes leaks a blob per frame for the length of a login. The previous
//     URL is revoked as the new one replaces it, and the last one on teardown.

/**
 * The socket surface this hook uses, structurally.
 *
 * Same shape and same reason as `voice-socket-transport.ts`'s: the DOM's
 * `WebSocket.send` narrows to `ArrayBufferView<ArrayBuffer>`, and a
 * `Uint8Array` off the frame codec is `Uint8Array<ArrayBufferLike>` — assignable
 * at runtime, refused by `lib.dom`. Naming the surface here keeps the cast out
 * of every call site.
 */
interface TakeoverWebSocket {
  readonly readyState: number;
  readonly OPEN: number;
  binaryType: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface TakeoverConnection {
  status: TakeoverStageStatus;
  /** The honest sentence when the lane refuses. Null while it is fine. */
  notice: string | null;
  /** Newest frame as an object URL, or null before the first one. */
  frameSrc: string | null;
  /** The page URL, following the lane's `url` frames. */
  url: string;
  /**
   * The last `handback` frame this lane sent came back refused, and no newer
   * one has gone out.
   *
   * A LANE fact, so the lane owns it: the server answers a `handback` frame
   * with either `closed: handed_back` or `error: handback_failed`, and only
   * this hook sees either. It is cleared by `send`ing another `handback`,
   * which is the only thing that can make it stale.
   */
  handbackRefused: boolean;
  /** Send one input frame. No-op while the socket is not open. */
  send: (frame: BrowserTakeoverClientFrame) => void;
}

export interface TakeoverSocketOptions {
  /** The browser session under takeover (`ClarifyMeta.sessionId`). */
  sessionId: string | undefined;
  /** The clarify a hand-back resolves. */
  requestId: string;
  /** The page URL the card already knows, shown until the lane reports one. */
  initialUrl: string;
  /** False keeps the socket closed — the stage is collapsed or not offered. */
  enabled: boolean;
}

/** ws(s):// origin for this page's web-api. */
function socketUrl(path: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${path}`;
}

export function useTakeoverSocket(opts: TakeoverSocketOptions): TakeoverConnection {
  const { sessionId, requestId, initialUrl, enabled } = opts;
  const [status, setStatus] = useState<TakeoverStageStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [url, setUrl] = useState(initialUrl);
  const [handbackRefused, setHandbackRefused] = useState(false);
  const socketRef = useRef<TakeoverWebSocket | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    if (typeof WebSocket === 'undefined') return;

    let current: string | null = null;
    // The same `as unknown as` the voice transport uses for the same reason
    // (`voice-socket-transport.ts:70`): the two `send` signatures differ only
    // in `lib.dom`'s ArrayBuffer narrowing, which no runtime value violates.
    const socket = new WebSocket(
      socketUrl(BROWSER_TAKEOVER_SOCKET_PATH),
    ) as unknown as TakeoverWebSocket;
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    setStatus('connecting');

    socket.onopen = () => {
      socket.send(encodeBrowserTakeoverFrame({ t: 'hello', sessionId, requestId }));
    };

    socket.onmessage = (event: { data: unknown }) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      const decoded = decodeBrowserTakeoverServerFrame(bytes);
      if (!decoded) return;
      const frame = decoded.header;
      if (frame.t === 'ready') {
        setStatus('live');
        setNotice(null);
        setUrl(frame.url);
        return;
      }
      if (frame.t === 'url') {
        setUrl(frame.url);
        return;
      }
      if (frame.t === 'frame') {
        // Copied into its own ArrayBuffer, not wrapped: `payload` is a
        // subarray of the received frame, and a Blob holding a view onto a
        // buffer the next message reuses is a picture that changes underneath.
        const owned = new ArrayBuffer(decoded.payload.byteLength);
        new Uint8Array(owned).set(decoded.payload);
        const blob = new Blob([owned], { type: 'image/jpeg' });
        const next = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setFrameSrc(next);
        // Ack immediately: CDP emits nothing more until this lands, so a
        // deferred ack is a frozen picture, not a slower one.
        if (socket.readyState === socket.OPEN) {
          socket.send(encodeBrowserTakeoverFrame({ t: 'ack', seq: frame.seq }));
        }
        return;
      }
      if (frame.t === 'closed') {
        setStatus(frame.reason === 'handed_back' ? 'ended' : 'unavailable');
        if (frame.reason === 'taken_over') {
          setNotice('Another tab took over this browser.');
        } else if (frame.reason === 'session_gone') {
          setNotice('The agent’s browser session is gone.');
        }
        return;
      }
      // A refused hand-back is the ONE error the lane sends without closing:
      // the server restarted the screencast and said "the browser is still
      // yours — try again". Painting `unavailable` over that stopped the retry
      // it invites — `TakeoverStage` gates every click and keystroke on
      // `live`, and only a `ready` frame restores it, which the server has no
      // reason to send again. So the status is left exactly as it was and the
      // refusal travels as its own flag.
      if (frame.code === 'handback_failed') {
        setNotice(frame.message);
        setHandbackRefused(true);
        return;
      }
      setStatus('unavailable');
      setNotice(frame.message);
    };

    socket.onerror = () => {
      setStatus('unavailable');
      setNotice('Could not reach the live view of the agent’s browser.');
    };

    socket.onclose = () => {
      // Only a close that arrives BEFORE a `closed`/`error` frame is news; the
      // frames above already said what happened and say it better.
      setStatus((prev) => (prev === 'live' || prev === 'connecting' ? 'unavailable' : prev));
    };

    return () => {
      socketRef.current = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      if (current) URL.revokeObjectURL(current);
      setFrameSrc(null);
    };
  }, [enabled, sessionId, requestId]);

  const send = useCallback((frame: BrowserTakeoverClientFrame) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== socket.OPEN) return;
    // A new attempt is outstanding, so the previous refusal — and the sentence
    // explaining it — are no longer what is true.
    if (frame.t === 'handback') {
      setHandbackRefused(false);
      setNotice(null);
    }
    socket.send(encodeBrowserTakeoverFrame(frame));
  }, []);

  return { status, notice, frameSrc, url, handbackRefused, send };
}

/** The browser hands a Blob, an ArrayBuffer or a view, depending on the agent. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null;
}

/**
 * Whether this viewport can host the stage at all. Read once per render rather
 * than through a media-query subscription: the mode is entered by an explicit
 * click, and a window resized across the threshold mid-takeover is not a case
 * worth a listener.
 */
export function takeoverStageFits(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth >= TAKEOVER_MIN_WIDTH;
}
