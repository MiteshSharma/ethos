import type { AgentLoop } from '@ethosagent/core';
import { AtroposWriter } from './atropos-writer';
import { readCheckpoint, writeCheckpoint } from './checkpoint';
import { Semaphore } from './semaphore';
import type {
  AtroposToolCall,
  AtroposToolResult,
  AtroposUsage,
  BatchRunOptions,
  BatchStats,
  BatchTask,
} from './types';
import { ATROPOS_SCHEMA_VERSION } from './types';

export class BatchRunner {
  constructor(
    private readonly loop: AgentLoop,
    private readonly options: BatchRunOptions,
  ) {}

  async run(
    tasks: BatchTask[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<BatchStats> {
    const checkpoint = await readCheckpoint(this.options.checkpointPath);
    const completed = new Set(checkpoint.completedTaskIds);
    const failed = new Set(checkpoint.failedTaskIds);

    const pending = tasks.filter((t) => !completed.has(t.id) && !failed.has(t.id));
    const skipped = tasks.length - pending.length;

    const writer = new AtroposWriter(this.options.outputPath);
    // Fresh run (no checkpoint) → truncate output so stale records don't accumulate.
    await writer.init(
      checkpoint.completedTaskIds.length === 0 && checkpoint.failedTaskIds.length === 0,
    );

    let stopping = false;
    const onSigterm = () => {
      stopping = true;
    };
    process.on('SIGTERM', onSigterm);

    const sem = new Semaphore(this.options.concurrency);
    const promises: Promise<void>[] = [];

    for (const task of pending) {
      if (stopping) break;

      const p = (async () => {
        await sem.acquire();
        if (stopping) {
          sem.release();
          return;
        }
        try {
          await this.runTask(task, writer, completed, failed);
        } finally {
          sem.release();
          onProgress?.(completed.size + failed.size, tasks.length);
        }
      })();

      promises.push(p);
    }

    await Promise.allSettled(promises);
    process.off('SIGTERM', onSigterm);

    return {
      total: tasks.length,
      completed: completed.size,
      failed: failed.size,
      skipped,
    };
  }

  private async runTask(
    task: BatchTask,
    writer: AtroposWriter,
    completed: Set<string>,
    failed: Set<string>,
  ): Promise<void> {
    const sessionKey = `batch:${task.id}`;
    const personalityId = task.personalityId ?? this.options.defaultPersonalityId;

    await writer.append({
      schema_version: ATROPOS_SCHEMA_VERSION,
      task_id: task.id,
      turn: 0,
      role: 'user',
      content: task.prompt,
      usage: null,
    });

    let text = '';
    let usage: AtroposUsage | null = null;
    const toolCalls: AtroposToolCall[] = [];
    const toolResults: AtroposToolResult[] = [];

    try {
      for await (const event of this.loop.run(task.prompt, { sessionKey, personalityId })) {
        switch (event.type) {
          case 'text_delta':
            text += event.text;
            break;
          case 'tool_start':
            toolCalls.push({ name: event.toolName, args: event.args });
            break;
          case 'tool_end':
            toolResults.push({ name: event.toolName, ok: event.ok });
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

      const assistantRecord = {
        schema_version: ATROPOS_SCHEMA_VERSION,
        task_id: task.id,
        turn: 0,
        role: 'assistant' as const,
        content: text,
        usage,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      await writer.append(assistantRecord);

      if (toolResults.length > 0) {
        await writer.append({
          schema_version: ATROPOS_SCHEMA_VERSION,
          task_id: task.id,
          turn: 0,
          role: 'tool',
          content: '',
          tool_results: toolResults,
          usage: null,
        });
      }

      completed.add(task.id);
    } catch (err) {
      await writer.append({
        schema_version: ATROPOS_SCHEMA_VERSION,
        task_id: task.id,
        turn: 0,
        role: 'assistant',
        content: '',
        error: err instanceof Error ? err.message : String(err),
        usage: null,
      });
      failed.add(task.id);
    }

    // Atomic checkpoint after each task — safe even if two tasks finish concurrently
    // because JS is single-threaded and Set mutations are synchronous.
    const state = {
      version: 1 as const,
      completedTaskIds: [...completed],
      failedTaskIds: [...failed],
    };
    await writeCheckpoint(this.options.checkpointPath, state);
  }
}

export function parseTasksJsonl(src: string): BatchTask[] {
  return src
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.id !== 'string' || typeof obj.prompt !== 'string') {
        throw new Error(`Line ${i + 1}: each task must have string fields "id" and "prompt"`);
      }
      return {
        id: obj.id,
        prompt: obj.prompt,
        personalityId: typeof obj.personalityId === 'string' ? obj.personalityId : undefined,
      };
    });
}
