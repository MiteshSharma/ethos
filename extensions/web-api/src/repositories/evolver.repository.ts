import { join } from 'node:path';
import {
  DEFAULT_EVOLVE_CONFIG,
  type EvolveConfig,
  loadEvolveConfig,
} from '@ethosagent/skill-evolver';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import type { EvolverRun } from '@ethosagent/web-contracts';

// Web-internal repository for the SkillEvolver's surrounding metadata —
// the threshold config and the append-only run log. The evolver itself
// (analyse + LLM call + writes-to-pending) lives in @ethosagent/skill-
// evolver and is invoked out-of-band by the CLI / a future cron worker;
// this repository only exposes its inputs and outputs to the web tab.
//
//   ~/.ethos/evolve-config.json     — current EvolveConfig (shared with
//                                     the `ethos evolve` CLI command)
//   ~/.ethos/evolver-history.jsonl  — append-only run log

export interface EvolverRepositoryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

interface RunRecord {
  ranAt: string;
  evalOutputPath: string;
  rewritesProposed: number;
  newSkillsProposed: number;
  skipped: Array<{ kind: 'rewrite' | 'new'; target: string; reason: string }>;
}

export class EvolverRepository {
  private readonly storage: Storage;
  private readonly configPath: string;
  private readonly historyPath: string;
  private readonly dataDir: string;

  constructor(opts: EvolverRepositoryOptions) {
    this.storage = opts.storage ?? new FsStorage();
    this.dataDir = opts.dataDir;
    this.configPath = join(opts.dataDir, 'evolve-config.json');
    this.historyPath = join(opts.dataDir, 'evolver-history.jsonl');
  }

  async getConfig(): Promise<EvolveConfig> {
    return loadEvolveConfig(this.configPath, this.storage);
  }

  async setConfig(config: EvolveConfig): Promise<EvolveConfig> {
    await this.storage.mkdir(this.dataDir);
    const merged: EvolveConfig = {
      rewriteThreshold: clamp(
        config.rewriteThreshold,
        0,
        1,
        DEFAULT_EVOLVE_CONFIG.rewriteThreshold,
      ),
      newSkillPatternThreshold: clamp(
        config.newSkillPatternThreshold,
        0,
        1,
        DEFAULT_EVOLVE_CONFIG.newSkillPatternThreshold,
      ),
      minRunsBeforeEvolve: Math.max(0, Math.floor(config.minRunsBeforeEvolve)),
      minPatternCount: Math.max(0, Math.floor(config.minPatternCount)),
    };
    await this.storage.write(this.configPath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  }

  async listHistory(limit: number): Promise<EvolverRun[]> {
    const raw = await this.storage.read(this.historyPath);
    if (!raw) return [];
    const records: EvolverRun[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as RunRecord;
        records.push({
          ranAt: parsed.ranAt,
          evalOutputPath: parsed.evalOutputPath,
          rewritesProposed: parsed.rewritesProposed,
          newSkillsProposed: parsed.newSkillsProposed,
          skipped: parsed.skipped ?? [],
        });
      } catch {
        // Skip malformed lines rather than failing the whole list.
      }
    }
    // Newest first.
    records.sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
    return records.slice(0, limit);
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
