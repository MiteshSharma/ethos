import type { AgentMesh, MeshEntry } from '@ethosagent/agent-mesh';
import type { MeshAgent, MeshRouteResult } from '@ethosagent/web-contracts';

// Mesh service. Two reads — `list` and `routeTest`. Calls into
// @ethosagent/agent-mesh directly (no repository wrapper) since the
// only translation needed is shaping a `MeshEntry` into the wire-format
// `MeshAgent` / `MeshRouteResult`.

export interface MeshServiceOptions {
  mesh: AgentMesh;
}

export class MeshService {
  constructor(private readonly opts: MeshServiceOptions) {}

  async list(): Promise<{ agents: MeshAgent[] }> {
    const entries = await this.opts.mesh.list();
    return { agents: entries.map(toWireAgent) };
  }

  async routeTest(capability: string): Promise<MeshRouteResult> {
    const picked = await this.opts.mesh.route(capability);
    if (!picked) {
      return {
        ok: false,
        routedTo: null,
        reason: `No live mesh agent advertises capability "${capability}".`,
      };
    }
    return { ok: true, routedTo: picked.agentId, reason: null };
  }
}

function toWireAgent(entry: MeshEntry): MeshAgent {
  return {
    agentId: entry.agentId,
    capabilities: entry.capabilities,
    activeSessions: entry.activeSessions,
    lastSeenAt: new Date(entry.lastHeartbeatAt).toISOString(),
  };
}
