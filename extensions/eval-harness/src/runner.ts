import { appendFile, writeFile } from 'node:fs/promises';
import type { AtroposRecord, AtroposUsage, BatchTask } from '@ethosagent/batch-runner';
import { ATROPOS_SCHEMA_VERSION } from '@ethosagent/batch-runner';
import type { AgentLoop } from '@ethosagent/core';
import {
  containsScorer,
  exactMatchScorer,
  llmJudgeScorer,
  regexScorer,
  type Scorer,
} from './scorers';
import type { EvalExpected, EvalRunOptions, EvalStats } from './types';

class Writer {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  init(truncate: boolean): Promise<void> {
    if (truncate) return writeFile(this.path, '', 'utf-8');
    return Promise.resolve();
  }

  append(record: AtroposRecord): Promise<void> {
    this.chain = this.chain.then(() =>
      appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf-8'),
    );
    return this.chain;
  }
}

class Semaphore {
  private readonly queue: Array<() => void> = [];

  constructor(private count: number) {}

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}

export class EvalRunner {
  constructor(
    private readonly loop: AgentLoop,
    private readonly options: EvalRunOptions,
  ) {}

  async run(
    tasks: BatchTask[],
    expectedMap: Map<string, EvalExpected>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<EvalStats> {
    const writer = new Writer(this.options.outputPath);
    await writer.init(true);

    const sem = new Semaphore(this.options.concurrency);
    const promises: Promise<void>[] = [];
    let passed = 0;
    let failed = 0;
    let scoreSum = 0;

    for (const task of tasks) {
      const p = (async () => {
        await sem.acquire();
        try {
          const { score } = await this.runTask(task, expectedMap, writer);
          scoreSum += score;
          if (score >= 1) passed++;
          else failed++;
        } finally {
          sem.release();
          onProgress?.(passed + failed, tasks.length);
        }
      })();
      promises.push(p);
    }

    await Promise.allSettled(promises);

    const total = tasks.length;
    return { total, passed, failed, avgScore: total > 0 ? scoreSum / total : 0 };
  }

  private resolveScorer(match: EvalExpected['match']): Scorer {
    const kind = match ?? this.options.defaultScorer;
    switch (kind) {
      case 'exact':
        return exactMatchScorer;
      case 'regex':
        return regexScorer;
      case 'llm': {
        const { llmProvider } = this.options;
        if (!llmProvider) throw new Error('llm scorer requires llmProvider in EvalRunOptions');
        return llmJudgeScorer(llmProvider);
      }
      default:
        return containsScorer;
    }
  }

  private async runTask(
    task: BatchTask,
    expectedMap: Map<string, EvalExpected>,
    writer: Writer,
  ): Promise<{ score: number }> {
    const sessionKey = `eval:${task.id}`;

    await writer.append({
      schema_version: ATROPOS_SCHEMA_VERSION,
      task_id: task.id,
      turn: 0,
      role: 'user',
      content: task.prompt,
      usage: null,
    });

    let text = '';
    let skillFilesUsed: string[] = [];
    let usage: AtroposUsage | null = null;
    let errorMsg: string | undefined;

    try {
      for await (const event of this.loop.run(task.prompt, {
        sessionKey,
        personalityId: task.personalityId,
      })) {
        switch (event.type) {
          case 'text_delta':
            text += event.text;
            break;
          case 'context_meta':
            if (Array.isArray(event.data.skillFilesUsed)) {
              skillFilesUsed = event.data.skillFilesUsed as string[];
            }
            break;
          case 'usage':
            usage = {
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
              estimated_cost_usd: event.estimatedCostUsd,
            };
            break;
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const expected = expectedMap.get(task.id);
    let score = 0;
    let scorerName: string = this.options.defaultScorer;

    if (!errorMsg && expected) {
      scorerName = expected.match ?? this.options.defaultScorer;
      const scorer = this.resolveScorer(expected.match);
      score = await scorer(text, expected);
    }

    await writer.append({
      schema_version: ATROPOS_SCHEMA_VERSION,
      task_id: task.id,
      turn: 0,
      role: 'assistant',
      content: text,
      usage,
      score,
      scorer: scorerName,
      skill_files_used: skillFilesUsed,
      ...(errorMsg ? { error: errorMsg } : {}),
    });

    return { score };
  }
}

export function parseExpectedJsonl(src: string): Map<string, EvalExpected> {
  const map = new Map<string, EvalExpected>();
  const lines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.expected !== 'string') {
      throw new Error(
        `Line ${i + 1}: each expected record must have string fields "id" and "expected"`,
      );
    }
    const match =
      obj.match === 'exact' ||
      obj.match === 'contains' ||
      obj.match === 'regex' ||
      obj.match === 'llm'
        ? obj.match
        : undefined;
    map.set(obj.id, { id: obj.id, expected: obj.expected, match });
  }

  return map;
}
