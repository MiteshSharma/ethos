import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import type {
  EvalRecord,
  EvolutionPlan,
  EvolveConfig,
  NewSkillCandidate,
  RewriteCandidate,
  SkillStats,
  TaskSummary,
} from './types';

const defaultStorage = new FsStorage();

export const DEFAULT_EVOLVE_CONFIG: EvolveConfig = {
  rewriteThreshold: 0.6,
  newSkillPatternThreshold: 0.8,
  minRunsBeforeEvolve: 10,
  minPatternCount: 3,
};

// Cap how many high-score zero-skill tasks we hand to the LLM in one prompt.
// Large bundles dilute the signal and bloat tokens; 20 is enough to spot a
// pattern without overwhelming the model.
const NEW_SKILL_BUNDLE_MAX = 20;

// Cap how many low-scoring transcripts we include per rewrite candidate.
const REWRITE_TRANSCRIPT_MAX = 8;

export function parseEvalJsonl(src: string): EvalRecord[] {
  const records: EvalRecord[] = [];
  const lines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (!isEvalRecord(obj)) {
      throw new Error(`Line ${i + 1}: missing required fields task_id/role/content`);
    }
    records.push(obj);
  }

  return records;
}

function isEvalRecord(obj: unknown): obj is EvalRecord {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.task_id === 'string' &&
    typeof r.role === 'string' &&
    (r.role === 'user' || r.role === 'assistant' || r.role === 'tool') &&
    typeof r.content === 'string'
  );
}

export async function loadEvolveConfig(
  path: string,
  storage: Storage = defaultStorage,
): Promise<EvolveConfig> {
  const raw = await storage.read(path);
  if (!raw) return DEFAULT_EVOLVE_CONFIG;
  const parsed = JSON.parse(raw) as Partial<EvolveConfig>;
  return {
    rewriteThreshold: parsed.rewriteThreshold ?? DEFAULT_EVOLVE_CONFIG.rewriteThreshold,
    newSkillPatternThreshold:
      parsed.newSkillPatternThreshold ?? DEFAULT_EVOLVE_CONFIG.newSkillPatternThreshold,
    minRunsBeforeEvolve: parsed.minRunsBeforeEvolve ?? DEFAULT_EVOLVE_CONFIG.minRunsBeforeEvolve,
    minPatternCount: parsed.minPatternCount ?? DEFAULT_EVOLVE_CONFIG.minPatternCount,
  };
}

interface PartialTask {
  prompt: string;
  response: string;
  score: number | undefined;
  skillFilesUsed: string[];
  errored: boolean;
}

function summarizeTasks(records: EvalRecord[]): TaskSummary[] {
  const byId = new Map<string, PartialTask>();

  for (const r of records) {
    let task = byId.get(r.task_id);
    if (!task) {
      task = { prompt: '', response: '', score: undefined, skillFilesUsed: [], errored: false };
      byId.set(r.task_id, task);
    }
    if (r.role === 'user' && !task.prompt) {
      task.prompt = r.content;
    } else if (r.role === 'assistant') {
      task.response = r.content;
      if (typeof r.score === 'number') task.score = r.score;
      if (Array.isArray(r.skill_files_used)) task.skillFilesUsed = r.skill_files_used;
      if (r.error) task.errored = true;
    }
  }

  const out: TaskSummary[] = [];
  for (const [taskId, t] of byId) {
    if (t.errored) continue;
    if (typeof t.score !== 'number') continue;
    out.push({
      taskId,
      prompt: t.prompt,
      response: t.response,
      score: t.score,
      skillFilesUsed: t.skillFilesUsed,
    });
  }
  return out;
}

function computeSkillStats(tasks: TaskSummary[]): SkillStats[] {
  const agg = new Map<string, { runs: number; sum: number }>();

  for (const t of tasks) {
    for (const fileName of t.skillFilesUsed) {
      const cur = agg.get(fileName) ?? { runs: 0, sum: 0 };
      cur.runs += 1;
      cur.sum += t.score;
      agg.set(fileName, cur);
    }
  }

  return [...agg.entries()]
    .map(([fileName, { runs, sum }]) => ({
      fileName,
      runs,
      avgScore: runs > 0 ? sum / runs : 0,
      scoreSum: sum,
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function analyzeEvalOutput(
  records: EvalRecord[],
  skillsDir: string,
  config: EvolveConfig,
  storage: Storage = defaultStorage,
): Promise<EvolutionPlan> {
  const tasks = summarizeTasks(records);
  const skillStats = computeSkillStats(tasks);

  const rewriteCandidates: RewriteCandidate[] = [];
  for (const stats of skillStats) {
    if (stats.runs < config.minRunsBeforeEvolve) continue;
    if (stats.avgScore >= config.rewriteThreshold) continue;

    const currentContent = await storage.read(join(skillsDir, stats.fileName));
    if (currentContent === null) continue;

    const lowScoring = tasks
      .filter((t) => t.skillFilesUsed.includes(stats.fileName))
      .sort((a, b) => a.score - b.score)
      .slice(0, REWRITE_TRANSCRIPT_MAX);

    rewriteCandidates.push({
      fileName: stats.fileName,
      currentContent,
      stats,
      lowScoringTasks: lowScoring,
    });
  }

  const highScoreZeroSkill = tasks
    .filter((t) => t.score >= config.newSkillPatternThreshold && t.skillFilesUsed.length === 0)
    .sort((a, b) => b.score - a.score);

  const newSkillCandidates: NewSkillCandidate[] = [];
  if (highScoreZeroSkill.length >= config.minPatternCount) {
    newSkillCandidates.push({ tasks: highScoreZeroSkill.slice(0, NEW_SKILL_BUNDLE_MAX) });
  }

  return { skillStats, rewriteCandidates, newSkillCandidates };
}
