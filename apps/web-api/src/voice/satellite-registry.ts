import type { SatelliteServerFrame } from '@ethosagent/web-contracts';
import {
  WAKE_SETTINGS_DEFAULTS,
  type WakeRoute,
  type WakeRoutingTable,
  type WakeSettings,
} from '../repositories/config.repository';

// Which microphones in the house are currently connected, and what each one
// says it is doing.
//
// ONE instance, owned by `createWebApi` and handed to both the socket and the
// RPC layer — not a module-level map. The plan's "no process-global satellite
// state" criterion is about exactly this: a registry reached through an import
// is a registry two deployments in one process share, and a room's listening
// state is not a fact that should leak between them. Per-CONNECTION state
// (utterance buffers, the in-flight turn) is not here at all; it lives on the
// lane object, one per socket.
//
// The rows are what the Settings → Voice UI renders, so they are the node's own
// reported state rather than anything inferred from the socket. A microphone
// that says `degraded` because its wake model failed to load is still connected;
// an indicator derived from "the socket is open" would call that listening,
// which is the privacy defect the `state` frame exists to prevent.

export interface SatelliteNode {
  nodeId: string;
  laneId: string;
  displayName?: string;
  capabilities: { edgeStt: boolean; playback: boolean; captureSampleRate: number };
  state: 'listening' | 'muted' | 'wake_off' | 'speaking' | 'degraded';
  stateDetail?: string;
  wakeEnabled: boolean;
  probes: Array<{ name: string; ok: boolean; detail?: string }>;
  lastWake?: { phrase: string; personalityId: string; at: number };
  connectedAt: number;
}

/** Deliver one frame to ONE node's socket. Supplied by the lane at register. */
export type SatelliteSend = (frame: SatelliteServerFrame, payload?: Uint8Array) => void;

export interface SatelliteRegistryOptions {
  /** Re-read the wake table from live config. Called on demand and on refresh. */
  readTable: () => Promise<WakeRoutingTable>;
  /** Reports a table read that failed. The previous table stays in force. */
  onError?: (err: string) => void;
}

interface Connection {
  node: SatelliteNode;
  send: SatelliteSend;
}

export class SatelliteRegistry {
  private readonly opts: SatelliteRegistryOptions;
  private readonly connections = new Map<string, Connection>();
  /** Last successfully read table. Null until the first read completes. */
  private cached: WakeRoutingTable | null = null;

  constructor(opts: SatelliteRegistryOptions) {
    this.opts = opts;
  }

  list(): SatelliteNode[] {
    return [...this.connections.values()].map((c) => ({ ...c.node }));
  }

  /**
   * The current table, reading config on first use.
   *
   * Cached rather than re-read per wake: a wake is latency-critical and the
   * table only changes on a Settings save, which calls `refreshRoutes()`. A
   * hand-edited `config.yaml` therefore applies on the next reconnect or
   * restart — documented behaviour (see the `routes` frame in
   * `@ethosagent/web-contracts`), not a bug.
   */
  async table(): Promise<WakeRoutingTable> {
    if (this.cached) return this.cached;
    return (await this.reload()) ?? EMPTY_TABLE;
  }

  /** Re-read config and push the new table to every connected node. */
  async refreshRoutes(): Promise<void> {
    if ((await this.reload()) === null) return;
    this.broadcastRoutes();
  }

  /** Push the current routes + settings to every connected node. */
  broadcastRoutes(): void {
    const table = this.cached;
    if (!table) return;
    for (const conn of this.connections.values()) {
      conn.send(routesFrame(table, conn.node));
    }
  }

  /**
   * Mute or unmute one node from the UI. Returns false when no such node is
   * connected — the caller renders that as "not reachable", never as success.
   */
  setWakeEnabled(nodeId: string, enabled: boolean): boolean {
    const conn = this.connections.get(nodeId);
    if (!conn) return false;
    conn.node = { ...conn.node, wakeEnabled: enabled };
    conn.send({ t: 'set_wake_enabled', enabled });
    return true;
  }

  // --- called by the lane -------------------------------------------------

  /**
   * Bind a connection to a node id.
   *
   * A reconnect under the SAME id replaces the previous row rather than adding
   * a second: a node that lost its socket and came back is one microphone, and
   * two rows for it would make the UI report a house with more listeners than
   * it has. The displaced connection's socket is left to its own teardown —
   * unregister is id-and-lane matched, so the stale lane closing later cannot
   * evict the live row.
   */
  register(node: SatelliteNode, send: SatelliteSend): void {
    this.connections.set(node.nodeId, { node, send });
  }

  unregister(nodeId: string, laneId: string): void {
    const conn = this.connections.get(nodeId);
    if (conn?.node.laneId === laneId) this.connections.delete(nodeId);
  }

  /** Patch one row. Ignored when the lane no longer owns the id. */
  update(nodeId: string, laneId: string, patch: Partial<SatelliteNode>): void {
    const conn = this.connections.get(nodeId);
    if (!conn || conn.node.laneId !== laneId) return;
    conn.node = { ...conn.node, ...patch };
  }

  /** Push the current table to ONE node — the on-connect send. */
  pushRoutes(nodeId: string): void {
    const conn = this.connections.get(nodeId);
    if (!conn || !this.cached) return;
    conn.send(routesFrame(this.cached, conn.node));
  }

  private async reload(): Promise<WakeRoutingTable | null> {
    try {
      this.cached = await this.opts.readTable();
      return this.cached;
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

/** What a lane sees when the config read failed outright. Same defaults the
 *  parser applies, from the same constant — a second copy here would drift. */
const EMPTY_TABLE: WakeRoutingTable = {
  routes: [],
  nodes: {},
  settings: WAKE_SETTINGS_DEFAULTS,
};

/**
 * Build one node's `routes` frame.
 *
 * The route TABLE is deployment-wide — the operator edits "which phrases does
 * the house answer to?" in one place. The SETTINGS are per-node at the edges:
 * `voice.wake.nodes.<id>` picks that microphone's input device and can switch
 * that microphone off without touching the others. `wakeEnabled` is the
 * conjunction of the master switch and the node's override, because either one
 * saying no means no.
 */
function routesFrame(table: WakeRoutingTable, node: SatelliteNode): SatelliteServerFrame {
  const override = table.nodes[node.nodeId];
  const settings: WakeSettings = table.settings;
  return {
    t: 'routes',
    routes: table.routes.map((r: WakeRoute) => ({
      id: r.id,
      phrase: r.phrase,
      personalityId: r.personalityId,
      privileged: r.privileged,
      enabled: r.enabled,
    })),
    settings: {
      engine: settings.engine,
      sensitivity: settings.sensitivity,
      confirmationFrames: settings.confirmationFrames,
      // The operator's intent, ANDed with what the node can actually do: a node
      // whose on-device STT never loaded must not be told to transcribe locally,
      // or the server sits waiting for a `transcript` frame that will not come.
      edgeStt: settings.edgeStt && node.capabilities.edgeStt,
      idleTimeoutMs: settings.idleTimeoutMs,
      ...(override?.inputDevice ? { inputDevice: override.inputDevice } : {}),
      wakeEnabled: settings.wakeEnabled && override?.enabled !== false,
    },
  };
}
