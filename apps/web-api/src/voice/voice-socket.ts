import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '@ethosagent/types';
import {
  decodeVoiceClientFrame,
  encodeVoiceFrame,
  VOICE_SOCKET_PATH,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';
import { type WebSocket, WebSocketServer } from 'ws';
import type { RealtimeControlLaneDeps } from './realtime-control-lane';
import { RealtimeControlLane } from './realtime-control-lane';
import { refuseUpgrade, registerUpgradeRoute, type UpgradableServer } from './upgrade-router';
import { VoiceLane, type VoiceLaneSessionOpener } from './voice-lane';

// The `ws` half of the browser voice lane. Same upgrade posture as the ACP
// server (`apps/acp-server/src/index.ts`): `noServer: true` plus an explicit
// `upgrade` handler, so path, Origin and credentials are all checked before a
// socket is ever handed to application code. The path half of that check lives
// in `./upgrade-router` — one listener dispatching to every mounted lane —
// because this is no longer the only WebSocket lane on the server.
//
// This file owns the socket; `VoiceLane` owns the frame plumbing and the
// per-connection `VoiceSession` (opened lazily on `hello` via `opts.session`)
// owns the conversation. Each accepted connection gets its own lane and, once
// `hello` names a sample rate, its own session — nothing here is shared
// across connections.
//
// A connection carries EITHER tier. On the pipeline tier the frames are audio
// and `VoiceLane` handles them. On the realtime tier the audio has gone
// straight to the provider and this socket is the CONTROL channel:
// `realtime_*` frames route to a `RealtimeControlLane` instead — the agent, the
// talk-session lane, the transcript and the approval surface. Both lanes exist
// per connection and neither observes the other; which one does work is decided
// by the frames the browser actually sends.

export interface VoiceSocketOptions {
  /**
   * Per-connection pipeline `VoiceSession` opener. Absent → the pipeline tier
   * is not available: the handshake still completes, but an `audio` frame
   * gets a clear `voice_unavailable` error instead of silently going nowhere.
   */
  session?: (laneId: string) => VoiceLaneSessionOpener;
  /**
   * Per-connection realtime control deps. Absent → `realtime_*` frames are
   * ignored, which is the honest behaviour for a deployment with no agent
   * wired: the pipeline tier still works and nothing pretends to consult.
   */
  realtime?: (laneId: string) => RealtimeControlLaneDeps;
  /** Credential check for the upgrade request. Rejected → 401, no socket. */
  authenticate(req: IncomingMessage): Promise<boolean>;
  /** Extra Origins allowed beyond loopback. Same rule as the HTTP surface. */
  allowedOrigins?: string[];
  path?: string;
  logger?: Logger;
}

export type { UpgradableServer } from './upgrade-router';

export interface VoiceSocket {
  /** Serve this lane's path on a listening server's upgrade router. */
  attach(server: UpgradableServer): void;
  /** Live lane count — one per connected talk-mode client. */
  readonly laneCount: number;
  close(): Promise<void>;
}

/** One connection currently holding a lane key's live `VoiceLane`. */
interface LaneKeyHolder {
  socket: WebSocket;
  lane: VoiceLane;
  send: (frame: VoiceServerFrame, payload?: Uint8Array) => void;
}

export function createVoiceSocket(opts: VoiceSocketOptions): VoiceSocket {
  const path = opts.path ?? VOICE_SOCKET_PATH;
  const wss = new WebSocketServer({ noServer: true });
  const lanes = new Map<WebSocket, VoiceLane>();
  const controls = new Map<WebSocket, RealtimeControlLane>();
  let laneSeq = 0;

  // D8 — second tab is a takeover, not a second billed session. Every lane
  // key resolves to at most one LIVE connection at a time; a new connection
  // resolving to an already-held key evicts the old one instead of running
  // beside it (two STT pipelines, two TTS pipelines, two concurrent agent
  // turns, both writing the same session). The plain Map below is already
  // sufficient for that: `onLaneKey` is fully synchronous (no `await`
  // anywhere in its body) and JS is single-threaded, so the read of
  // `holders.get(laneKey)` and the write of `holders.set(laneKey, ...)`
  // inside one call can never be interleaved with another connection's call
  // — `holders` is always immediately, atomically consistent. A third,
  // fourth, Nth connection on the same key just cascades the same eviction
  // indefinitely: each one evicts whichever connection `holders` currently
  // names, which — by that same atomicity — is always the one genuinely
  // live at that instant. That cascade IS "one live session per key", which
  // is the actual thing that matters; there is no window in which two
  // connections could both believe they are the evictor of the same stale
  // holder.
  const holders = new Map<string, LaneKeyHolder>();

  const onConnection = (socket: WebSocket): void => {
    const laneId = `lane-${++laneSeq}-${Date.now().toString(36)}`;
    const send = (frame: VoiceServerFrame, payload?: Uint8Array): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeVoiceFrame(frame, payload), { binary: true });
    };
    /** Set once `onLaneKey` resolves this connection's own key, so teardown
     *  knows what (if anything) to release. */
    let myLaneKey: string | null = null;

    const onLaneKey = (laneKey: string): void => {
      const existing = holders.get(laneKey);
      if (!existing) {
        holders.set(laneKey, { socket, lane, send });
        myLaneKey = laneKey;
        return;
      }
      if (existing.socket === socket) return; // defensive; should not happen
      // Take over: tell the OLD connection why, close ITS session and
      // socket, then let this one proceed as the new holder. Cascades
      // cleanly for a third, fourth, Nth connection on the same key — see
      // the comment above `holders`.
      existing.send({
        t: 'error',
        code: 'taken_over',
        message: 'This voice call was taken over by another tab.',
      });
      existing.lane.close();
      existing.socket.close();
      holders.set(laneKey, { socket, lane, send });
      myLaneKey = laneKey;
    };

    const sessionOpener = opts.session?.(laneId);
    const lane = new VoiceLane({
      laneId,
      send,
      openSession: sessionOpener ?? (() => Promise.resolve(null)),
      onLaneKey,
    });
    lanes.set(socket, lane);
    const realtimeDeps = opts.realtime?.(laneId);
    const control = realtimeDeps
      ? new RealtimeControlLane({ deps: realtimeDeps, send: (frame) => send(frame) })
      : null;
    if (control) controls.set(socket, control);

    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = toBytes(data);
      if (!bytes) return;
      const frame = decodeVoiceClientFrame(bytes);
      if (!frame) {
        send({ t: 'error', code: 'bad_frame', message: 'Unrecognized voice frame — ignored.' });
        return;
      }
      if (frame.header.t.startsWith('realtime_')) {
        control?.handle(frame.header);
        return;
      }
      lane.handle(frame.header, frame.payload);
    });

    const teardown = (): void => {
      lane.close();
      control?.close();
      lanes.delete(socket);
      controls.delete(socket);
      if (myLaneKey) {
        // Only release the key if `holders` still points at THIS socket. An
        // evicted holder's own teardown must NOT delete the entry the
        // connection that took it over already installed — that would free
        // the key for an unrelated later connection while the takeover's
        // holder is still live.
        if (holders.get(myLaneKey)?.socket === socket) holders.delete(myLaneKey);
      }
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  };

  wss.on('connection', onConnection);

  // Path matching is the router's job now; this handler only sees requests for
  // `path` and owns the Origin + credential policy.
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
      for (const [socket, lane] of lanes) {
        lane.close();
        controls.get(socket)?.close();
        socket.close();
      }
      lanes.clear();
      controls.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Origin policy for the upgrade. No Origin header (a non-browser client) is
 * allowed — the credential check is what gates those. A browser Origin must be
 * loopback or explicitly allow-listed, which is what stops a random web page
 * from opening a mic lane against a local Ethos (DNS rebinding).
 */
export function originAllowed(origin: string | undefined, allowed?: string[]): boolean {
  if (!origin) return true;
  if (allowed?.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Read one cookie out of a raw `Cookie` header. A WebSocket upgrade cannot
 * carry an Authorization header from the browser, so the same httpOnly session
 * cookie the HTTP surface uses is the credential here too.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** `ws` hands a Buffer, an array of Buffers, or an ArrayBuffer depending on config. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data.filter((part): part is Uint8Array => part instanceof Uint8Array);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
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
