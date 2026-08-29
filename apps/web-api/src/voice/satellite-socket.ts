import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  decodeSatelliteClientFrame,
  encodeSatelliteFrame,
  SATELLITE_SOCKET_PATH,
  type SatelliteServerFrame,
} from '@ethosagent/web-contracts';
import { type WebSocket, WebSocketServer } from 'ws';
import { SatelliteLane, type SatelliteLaneDeps, type SatelliteLaneLimits } from './satellite-lane';
import type { SatelliteRegistry } from './satellite-registry';
import { refuseUpgrade, registerUpgradeRoute, type UpgradableServer } from './upgrade-router';
import { originAllowed } from './voice-socket';

// The `ws` half of the wake-satellite lane (`GET /satellite/ws`).
//
// Mounted on the WEB-API, not the gateway, and deliberately: this process
// already owns the auth cookie, the frame codec, the AgentLoop and the
// personality refresh, so a Settings save can push a routing table to every
// connected microphone as an in-process call. Across a process boundary there
// is no such call, only a notification protocol that does not exist.
//
// This file owns the socket; `SatelliteLane` owns the conversation and
// `SatelliteRegistry` owns the per-node rows the UI renders. One lane per
// connection, no shared per-utterance state.

export interface SatelliteSocketOptions {
  registry: SatelliteRegistry;
  /** Per-connection provider + loop seams. Built fresh per socket. */
  deps: (laneId: string) => SatelliteLaneDeps;
  /** Credential check for the upgrade request. Rejected → 401, no socket. */
  authenticate(req: IncomingMessage): Promise<boolean>;
  /** Extra Origins allowed beyond loopback. Same rule as the HTTP surface. */
  allowedOrigins?: string[];
  path?: string;
  limits?: Partial<SatelliteLaneLimits>;
}

export interface SatelliteSocket {
  /** Serve this lane's path on a listening server's upgrade router. */
  attach(server: UpgradableServer): void;
  /** Live lane count — one per connected satellite socket. */
  readonly laneCount: number;
  close(): Promise<void>;
}

export function createSatelliteSocket(opts: SatelliteSocketOptions): SatelliteSocket {
  const path = opts.path ?? SATELLITE_SOCKET_PATH;
  const wss = new WebSocketServer({ noServer: true });
  const lanes = new Map<WebSocket, SatelliteLane>();
  let laneSeq = 0;

  wss.on('connection', (socket: WebSocket): void => {
    const laneId = `sat-${++laneSeq}-${Date.now().toString(36)}`;
    const send = (frame: SatelliteServerFrame, payload?: Uint8Array): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeSatelliteFrame(frame, payload), { binary: true });
    };
    const lane = new SatelliteLane({
      laneId,
      send,
      registry: opts.registry,
      deps: opts.deps(laneId),
      ...(opts.limits ? { limits: opts.limits } : {}),
    });
    lanes.set(socket, lane);

    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = toBytes(data);
      if (!bytes) return;
      const frame = decodeSatelliteClientFrame(bytes);
      if (!frame.ok) {
        // A malformed frame is a bug in one satellite build, not a reason to
        // take the microphone offline — say so and keep the socket.
        //
        // SAY WHICH FRAME AND WHICH FIELD. The refusal used to read
        // "Unrecognized satellite frame — ignored.", which is the same sentence
        // for a truncated audio frame, a satellite built against a newer
        // framing version, and a `wake` missing a required field — so the only
        // way to tell them apart was to bisect the satellite build. The decoder
        // knows; it just used to throw the answer away. Payload bytes and
        // header text never reach this line — see `describeIssues`.
        send({
          t: 'error',
          code: 'bad_frame',
          message:
            `Rejected ${frame.frameType === undefined ? 'a satellite frame' : `a '${frame.frameType}' frame`}` +
            ` — ${frame.reason}. Ignored.`,
        });
        return;
      }
      lane.handle(frame.header, frame.payload);
    });

    const teardown = (): void => {
      lane.close();
      lanes.delete(socket);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  // Path matching belongs to the upgrade router; this handler owns the Origin
  // and credential policy for `path`.
  //
  // `originAllowed` permits an upgrade with NO Origin header, which is exactly
  // what a satellite sends: it is a daemon on a Pi, not a browser, so there is
  // no page origin to attest. The credential is what gates it — the same
  // `ethos_auth` cookie the browser lane presents, sent as a plain header by a
  // non-browser client. The loopback/allowlist rule still applies to anything
  // that DOES declare an Origin, so a hostile web page cannot open a satellite
  // lane against a local Ethos either.
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
        socket.close();
      }
      lanes.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
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
