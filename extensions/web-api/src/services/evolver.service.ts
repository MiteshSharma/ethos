import type { EvolveConfig } from '@ethosagent/skill-evolver';
import type { PendingSkillRecord, SkillsLibrary } from '@ethosagent/skills';
import type { EvolverRun, PendingSkill } from '@ethosagent/web-contracts';
import type { EvolverRepository } from '../repositories/evolver.repository';

// Evolver-tab service. Composes:
//
//   • EvolverRepository (web-only) — EvolveConfig file + run-history log
//   • SkillsLibrary    — the .pending directory (the approval queue)
//
// The actual SkillEvolver.evolve() is invoked by the CLI today
// (`ethos skills evolve`); this service only owns the data the web tab
// needs to surface.

export interface EvolverServiceOptions {
  evolver: EvolverRepository;
  library: SkillsLibrary;
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
    const pending = await this.opts.library.listPending();
    return { pending: pending.map(toWirePending) };
  }

  async approvePending(id: string): Promise<void> {
    await this.opts.library.approvePending(id);
  }

  async rejectPending(id: string): Promise<void> {
    await this.opts.library.rejectPending(id);
  }

  async listHistory(limit: number = 20): Promise<{ runs: EvolverRun[] }> {
    return { runs: await this.opts.evolver.listHistory(limit) };
  }
}

function toWirePending(record: PendingSkillRecord): PendingSkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    proposedAt: record.proposedAt,
  };
}
