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
import type { VoiceService } from '../services/voice.service';
import type { RealtimeControlLaneDeps } from './realtime-control-lane';
import { RealtimeControlLane } from './realtime-control-lane';
import { VoiceLane, type VoiceLaneLimits } from './voice-lane';

// The `ws` half of the browser voice lane. Same upgrade posture as the ACP
// server (`apps/acp-server/src/index.ts`): `noServer: true` plus an explicit
// `upgrade` handler, so path, Origin and credentials are all checked before a
// socket is ever handed to application code.
//
// This file owns the socket; `VoiceLane` owns the conversation. Each accepted
// connection gets its OWN lane — the only shared object is the `VoiceService`
// that resolves providers, which holds no per-call state.
//
// A connection carries EITHER tier. On the pipeline tier the frames are audio
// and `VoiceLane` handles them. On the realtime tier the audio has gone
// straight to the provider and this socket is the CONTROL channel:
// `realtime_*` frames route to a `RealtimeControlLane` instead — the agent, the
// talk-session lane, the transcript and the approval surface. Both lanes exist
// per connection and neither observes the other; which one does work is decided
// by the frames the browser actually sends.

export interface VoiceSocketOptions {
  voice: VoiceService;
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
  limits?: Partial<VoiceLaneLimits>;
  logger?: Logger;
}

/**
 * What `attach` needs: anything that emits `upgrade`. Typed structurally
 * because `@hono/node-server` returns an http/http2 union, not a plain
 * `http.Server`.
 */
export interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export interface VoiceSocket {
  /** Take over `upgrade` on a listening server. */
  attach(server: UpgradableServer): void;
  /** Live lane count — one per connected talk-mode client. */
  readonly laneCount: number;
  close(): Promise<void>;
}

export function createVoiceSocket(opts: VoiceSocketOptions): VoiceSocket {
  const path = opts.path ?? VOICE_SOCKET_PATH;
  const wss = new WebSocketServer({ noServer: true });
  const lanes = new Map<WebSocket, VoiceLane>();
  const controls = new Map<WebSocket, RealtimeControlLane>();
  let laneSeq = 0;

  const onConnection = (socket: WebSocket): void => {
    const laneId = `lane-${++laneSeq}-${Date.now().toString(36)}`;
    const send = (frame: VoiceServerFrame, payload?: Uint8Array): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeVoiceFrame(frame, payload), { binary: true });
    };
    const lane = new VoiceLane({
      laneId,
      send,
      ...(opts.limits ? { limits: opts.limits } : {}),
      deps: {
        transcribe: (audio, transcribeOpts) =>
          opts.voice.transcribeBytes(
            audio.data,
            audio.mimeType,
            transcribeOpts.signal,
            transcribeOpts.personalityId ? { personalityId: transcribeOpts.personalityId } : {},
          ),
        synthesize: (text, synthOpts) => opts.voice.synthesizeStream(text, synthOpts),
      },
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
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  };

  wss.on('connection', onConnection);

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = req.url ?? '';
    if (url.split('?')[0] !== path) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) {
      refuse(socket, 403, 'Forbidden');
      return;
    }
    opts
      .authenticate(req)
      .then((ok) => {
        if (!ok) {
          refuse(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      })
      .catch(() => refuse(socket, 401, 'Unauthorized'));
  };

  return {
    attach(server: UpgradableServer): void {
      server.on('upgrade', handleUpgrade);
    },
    get laneCount(): number {
      return lanes.size;
    },
    close(): Promise<void> {
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

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
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
