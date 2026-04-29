import { AgentMesh } from '@ethosagent/agent-mesh';
import type { MeshAgent, MeshRouteResult } from '@ethosagent/web-contracts';

// Thin file-backed adapter over @ethosagent/agent-mesh. The mesh module
// already does all the work (live filtering by 30s heartbeat staleness,
// least-busy routing); this repository just maps its internal shape into
// wire-format `MeshAgent` records and translates the route result into
// the `MeshRouteResult` shape the contract advertises.
//
// `AgentMesh` writes to `~/.ethos/mesh-registry.json` from the ACP
// server's heartbeat loop; this repository reads the same file. No
// shared instance needed — both ends round-trip through disk, so
// multiple `ethos serve` processes (or an ACP-only deployment alongside
// a separate web tab) all see the same registry.

export interface MeshRepositoryOptions {
  /** Override the registry path. Defaults to `~/.ethos/mesh-registry.json`. */
  registryPath?: string;
}

export class MeshRepository {
  private readonly mesh: AgentMesh;

  constructor(opts: MeshRepositoryOptions = {}) {
    this.mesh = opts.registryPath ? new AgentMesh(opts.registryPath) : new AgentMesh();
  }

  async list(): Promise<MeshAgent[]> {
    const entries = await this.mesh.list();
    return entries.map(toWireAgent);
  }

  async route(capability: string): Promise<MeshRouteResult> {
    const picked = await this.mesh.route(capability);
    if (!picked) {
      return {
        ok: false,
        routedTo: null,
        reason: `No live mesh agent advertises capability "${capability}".`,
      };
    }
    return {
      ok: true,
      routedTo: picked.agentId,
      reason: null,
    };
  }
}

function toWireAgent(entry: import('@ethosagent/agent-mesh').MeshEntry): MeshAgent {
  return {
    agentId: entry.agentId,
    capabilities: entry.capabilities,
    activeSessions: entry.activeSessions,
    lastSeenAt: new Date(entry.lastHeartbeatAt).toISOString(),
  };
}
