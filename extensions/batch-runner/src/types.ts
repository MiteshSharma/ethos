// Atropos schema version — consumers must reject records with unknown versions.
// Upgrade path: bump to "1.1", "2.0", etc. and document in CHANGELOG.
export const ATROPOS_SCHEMA_VERSION = '1.0' as const;

export interface BatchTask {
  id: string;
  prompt: string;
  personalityId?: string;
}

export interface AtroposToolCall {
  name: string;
  args: unknown;
}

export interface AtroposToolResult {
  name: string;
  ok: boolean;
}

export interface AtroposUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface AtroposRecord {
  schema_version: typeof ATROPOS_SCHEMA_VERSION;
  task_id: string;
  turn: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: AtroposToolCall[];
  tool_results?: AtroposToolResult[];
  usage?: AtroposUsage | null;
  error?: string;
  // Eval harness fields (Phase 22) — only present on scored assistant records.
  score?: number;
  scorer?: string;
  skill_files_used?: string[];
}

export interface CheckpointState {
  version: 1;
  completedTaskIds: string[];
  failedTaskIds: string[];
}

export interface BatchRunOptions {
  concurrency: number;
  outputPath: string;
  checkpointPath: string;
  defaultPersonalityId: string;
}

export interface BatchStats {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
}
