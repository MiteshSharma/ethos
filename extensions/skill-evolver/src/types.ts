export interface EvolveConfig {
  rewriteThreshold: number;
  newSkillPatternThreshold: number;
  minRunsBeforeEvolve: number;
  minPatternCount: number;
}

export interface EvalRecord {
  task_id: string;
  turn: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  score?: number;
  scorer?: string;
  skill_files_used?: string[];
  error?: string;
}

export interface TaskSummary {
  taskId: string;
  prompt: string;
  response: string;
  score: number;
  skillFilesUsed: string[];
}

export interface SkillStats {
  fileName: string;
  runs: number;
  avgScore: number;
  scoreSum: number;
}

export interface RewriteCandidate {
  fileName: string;
  currentContent: string;
  stats: SkillStats;
  lowScoringTasks: TaskSummary[];
}

export interface NewSkillCandidate {
  tasks: TaskSummary[];
}

export interface EvolutionPlan {
  skillStats: SkillStats[];
  rewriteCandidates: RewriteCandidate[];
  newSkillCandidates: NewSkillCandidate[];
}
