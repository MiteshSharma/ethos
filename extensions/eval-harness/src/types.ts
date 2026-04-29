import type { LLMProvider, Storage } from '@ethosagent/types';

export interface EvalExpected {
  id: string;
  expected: string;
  match?: 'exact' | 'contains' | 'regex' | 'llm';
}

export interface EvalRunOptions {
  concurrency: number;
  outputPath: string;
  defaultScorer: 'exact' | 'contains' | 'regex' | 'llm';
  llmProvider?: LLMProvider;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

export interface EvalStats {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
}
