import type { EvolveConfig } from '@ethosagent/skill-evolver';
import type { EvolverRun, PendingSkill } from '@ethosagent/web-contracts';
import type { EvolverRepository } from '../repositories/evolver.repository';
import type { SkillsRepository } from '../repositories/skills.repository';

// Evolver-tab service. Composes two repositories:
//
//   • EvolverRepository  — the EvolveConfig file + run-history log
//   • SkillsRepository   — the .pending directory (the approval queue)
//
// The actual SkillEvolver.evolve() is invoked by the CLI today
// (`ethos skills evolve`); this service only owns the data the web tab
// needs to surface. Evolver-loop wiring on the cron worker is the v0.5
// follow-up commit that produces the cron.fired / evolve.skill_pending
// SSE events the right drawer is already prepared to render.

export interface EvolverServiceOptions {
  evolver: EvolverRepository;
  skills: SkillsRepository;
}

export class EvolverService {
  constructor(private readonly opts: EvolverServiceOptions) {}

  async getConfig(): Promise<{ config: EvolveConfig }> {
    return { config: await this.opts.evolver.getConfig() };
  }

  async updateConfig(config: EvolveConfig): Promise<{ config: EvolveConfig }> {
    return { config: await this.opts.evolver.setConfig(config) };
  }

  async listPending(): Promise<{ pending: PendingSkill[] }> {
    return { pending: await this.opts.skills.listPending() };
  }

  async approvePending(id: string): Promise<void> {
    await this.opts.skills.approvePending(id);
  }

  async rejectPending(id: string): Promise<void> {
    await this.opts.skills.rejectPending(id);
  }

  async listHistory(limit: number = 20): Promise<{ runs: EvolverRun[] }> {
    return { runs: await this.opts.evolver.listHistory(limit) };
  }
}
