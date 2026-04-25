import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtroposRecord, BatchTask } from '../index';
import { BatchRunner, parseTasksJsonl, readCheckpoint } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-batch-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeLoop(events: AgentEvent[][]): AgentLoop {
  let callIndex = 0;
  return {
    run: async function* (_prompt: string, _opts: unknown) {
      const evts = events[callIndex++ % events.length] ?? [];
      for (const e of evts) yield e;
    },
  } as unknown as AgentLoop;
}

function makePaths() {
  return {
    outputPath: join(testDir, 'output.jsonl'),
    checkpointPath: join(testDir, 'checkpoint.json'),
  };
}

function makeRunner(loop: AgentLoop, concurrency = 1) {
  return new BatchRunner(loop, {
    concurrency,
    defaultPersonalityId: 'researcher',
    ...makePaths(),
  });
}

async function readOutput(dir: string): Promise<AtroposRecord[]> {
  const src = await readFile(join(dir, 'output.jsonl'), 'utf-8');
  return src
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AtroposRecord);
}

const tasks: BatchTask[] = [
  { id: 'task-1', prompt: 'Hello' },
  { id: 'task-2', prompt: 'World' },
];

const textEvents: AgentEvent[] = [
  { type: 'text_delta', text: 'Hi there' },
  { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
  { type: 'done', text: 'Hi there', turnCount: 1 },
];

// ---------------------------------------------------------------------------
// parseTasksJsonl
// ---------------------------------------------------------------------------

describe('parseTasksJsonl', () => {
  it('parses valid JSONL', () => {
    const src = '{"id":"t1","prompt":"hello"}\n{"id":"t2","prompt":"world"}\n';
    const tasks = parseTasksJsonl(src);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ id: 't1', prompt: 'hello', personalityId: undefined });
    expect(tasks[1]).toEqual({ id: 't2', prompt: 'world', personalityId: undefined });
  });

  it('passes through personalityId', () => {
    const src = '{"id":"t1","prompt":"hi","personalityId":"engineer"}\n';
    expect(parseTasksJsonl(src)[0]?.personalityId).toBe('engineer');
  });

  it('ignores blank lines', () => {
    const src = '{"id":"t1","prompt":"hi"}\n\n{"id":"t2","prompt":"bye"}\n';
    expect(parseTasksJsonl(src)).toHaveLength(2);
  });

  it('throws on missing required fields', () => {
    expect(() => parseTasksJsonl('{"id":"t1"}\n')).toThrow('prompt');
  });
});

// ---------------------------------------------------------------------------
// BatchRunner — basic run
// ---------------------------------------------------------------------------

describe('BatchRunner.run', () => {
  it('runs tasks and produces Atropos JSONL', async () => {
    const loop = makeLoop([textEvents, textEvents]);
    const runner = makeRunner(loop);
    const stats = await runner.run(tasks);

    expect(stats.total).toBe(2);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.skipped).toBe(0);

    const records = await readOutput(testDir);
    // Each task: 1 user record + 1 assistant record = 2 records × 2 tasks = 4
    expect(records).toHaveLength(4);
    expect(records.every((r) => r.schema_version === '1.0')).toBe(true);
    expect(records.filter((r) => r.role === 'user')).toHaveLength(2);
    expect(records.filter((r) => r.role === 'assistant')).toHaveLength(2);
  });

  it('captures text and usage on assistant records', async () => {
    const loop = makeLoop([textEvents]);
    const runner = makeRunner(loop);
    const task = tasks[0];
    if (!task) throw new Error('fixture missing');
    await runner.run([task]);

    const records = await readOutput(testDir);
    const assistant = records.find((r) => r.role === 'assistant');
    expect(assistant?.content).toBe('Hi there');
    expect(assistant?.usage?.input_tokens).toBe(10);
  });

  it('captures tool_calls and tool_results', async () => {
    const toolEvents: AgentEvent[] = [
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: '/tmp/x' } },
      { type: 'tool_end', toolCallId: 'c1', toolName: 'read_file', ok: true, durationMs: 5 },
      { type: 'text_delta', text: 'done' },
      { type: 'done', text: 'done', turnCount: 1 },
    ];
    const loop = makeLoop([toolEvents]);
    const runner = makeRunner(loop);
    const task = tasks[0];
    if (!task) throw new Error('fixture missing');
    await runner.run([task]);

    const records = await readOutput(testDir);
    const assistant = records.find((r) => r.role === 'assistant');
    expect(assistant?.tool_calls).toHaveLength(1);
    expect(assistant?.tool_calls?.[0]?.name).toBe('read_file');

    const tool = records.find((r) => r.role === 'tool');
    expect(tool?.tool_results).toHaveLength(1);
    expect(tool?.tool_results?.[0]?.ok).toBe(true);
  });

  it('marks task as failed and records error on thrown exception', async () => {
    const loop = {
      run: async function* () {
        yield* []; // required to satisfy useYield; throws before any yield
        throw new Error('LLM unavailable');
      },
    } as unknown as AgentLoop;

    const runner = makeRunner(loop);
    const task = tasks[0];
    if (!task) throw new Error('fixture missing');
    const stats = await runner.run([task]);

    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);

    const records = await readOutput(testDir);
    const errRecord = records.find((r) => r.role === 'assistant');
    expect(errRecord?.error).toBe('LLM unavailable');
  });

  it('skips already-completed tasks from checkpoint', async () => {
    // Pre-write a checkpoint marking task-1 as done
    const { writeCheckpoint } = await import('../checkpoint');
    await writeCheckpoint(join(testDir, 'checkpoint.json'), {
      version: 1,
      completedTaskIds: ['task-1'],
      failedTaskIds: [],
    });

    const calls: string[] = [];
    const loop = {
      run: async function* (_prompt: string, opts: { sessionKey: string }) {
        calls.push(opts.sessionKey);
        yield { type: 'text_delta', text: 'ok' } as AgentEvent;
        yield { type: 'done', text: 'ok', turnCount: 1 } as AgentEvent;
      },
    } as unknown as AgentLoop;

    const runner = makeRunner(loop);
    const stats = await runner.run(tasks);

    expect(stats.skipped).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('batch:task-2');
  });

  it('checkpoints atomically after each task', async () => {
    const loop = makeLoop([textEvents, textEvents]);
    const runner = makeRunner(loop);
    await runner.run(tasks);

    const cp = await readCheckpoint(join(testDir, 'checkpoint.json'));
    expect(cp.completedTaskIds).toContain('task-1');
    expect(cp.completedTaskIds).toContain('task-2');
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const concurrency = 2;
    const manyTasks: BatchTask[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      prompt: `p${i}`,
    }));

    const loop = {
      run: async function* () {
        active++;
        maxActive = Math.max(maxActive, active);
        // yield control so other tasks can start
        await new Promise<void>((r) => setImmediate(r));
        active--;
        yield { type: 'text_delta', text: 'x' } as AgentEvent;
        yield { type: 'done', text: 'x', turnCount: 1 } as AgentEvent;
      },
    } as unknown as AgentLoop;

    const runner = new BatchRunner(loop, {
      concurrency,
      defaultPersonalityId: 'researcher',
      ...makePaths(),
    });
    await runner.run(manyTasks);

    expect(maxActive).toBeLessThanOrEqual(concurrency);
  });
});
