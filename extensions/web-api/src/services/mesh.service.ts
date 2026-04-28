import type { MeshAgent, MeshRouteResult } from '@ethosagent/web-contracts';
import type { MeshRepository } from '../repositories/mesh.repository';

// Mesh service. Two reads — `list` and `routeTest` — so this is one of
// the smallest services in the web-api. Business logic that *would*
// belong here (capability inference, mesh-wide health rollups,
// cross-process coordination) hasn't materialised yet; if it does, it
// lands in this file rather than leaking into the route or the
// repository.

export interface MeshServiceOptions {
  repo: MeshRepository;
}

export class MeshService {
  constructor(private readonly opts: MeshServiceOptions) {}

  list(): { agents: MeshAgent[] } {
    return { agents: this.opts.repo.list() };
  }

  routeTest(capability: string): MeshRouteResult {
    return this.opts.repo.route(capability);
  }
}
