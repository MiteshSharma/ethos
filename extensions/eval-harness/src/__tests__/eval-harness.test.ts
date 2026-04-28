import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalRunner, parseExpectedJsonl } from '../runner';
import { containsScorer, exactMatchScorer, regexScorer } from '../scorers';
import type { EvalExpected } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-eval-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeLoop(responsesByTaskId: Record<string, string>): AgentLoop {
  let callIndex = 0;
  return {
    run: async function* (_prompt: string, opts: { sessionKey?: string }) {
      const taskId = opts.sessionKey?.replace('eval:', '') ?? String(callIndex++);
      const text = responsesByTaskId[taskId] ?? '';
      const events: AgentEvent[] = [
        { type: 'text_delta', text },
        { type: 'done', text, turnCount: 1 },
      ];
      for (const e of events) yield e;
    },
  } as unknown as AgentLoop;
}

function makeLoopWithMeta(
  responsesByTaskId: Record<string, string>,
  skillFiles: string[],
): AgentLoop {
  return {
    run: async function* (_prompt: string, opts: { sessionKey?: string }) {
      const taskId = opts.sessionKey?.replace('eval:', '') ?? '';
      const text = responsesByTaskId[taskId] ?? '';
      yield { type: 'context_meta', data: { skillFilesUsed: skillFiles } } as AgentEvent;
      yield { type: 'text_delta', text } as AgentEvent;
      yield { type: 'done', text, turnCount: 1 } as AgentEvent;
    },
  } as unknown as AgentLoop;
}

// ---------------------------------------------------------------------------
// Scorer unit tests
// ---------------------------------------------------------------------------

describe('exactMatchScorer', () => {
  const expected: EvalExpected = { id: 't1', expected: 'hello world' };

  it('returns 1 for exact match', async () => {
    expect(await exactMatchScorer('hello world', expected)).toBe(1);
  });

  it('returns 1 ignoring leading/trailing whitespace', async () => {
    expect(await exactMatchScorer('  hello world  ', expected)).toBe(1);
  });

  it('returns 0 for partial match', async () => {
    expect(await exactMatchScorer('hello', expected)).toBe(0);
  });

  it('returns 0 for empty response', async () => {
    expect(await exactMatchScorer('', expected)).toBe(0);
  });
});

describe('containsScorer', () => {
  const expected: EvalExpected = { id: 't1', expected: '42' };

  it('returns 1 when response contains expected string', async () => {
    expect(await containsScorer('The answer is 42.', expected)).toBe(1);
  });

  it('is case-insensitive', async () => {
    expect(await containsScorer('The Answer Is HELLO', { id: 't1', expected: 'hello' })).toBe(1);
  });

  it('returns 0 when response does not contain expected', async () => {
    expect(await containsScorer('The answer is 43.', expected)).toBe(0);
  });
});

describe('regexScorer', () => {
  it('returns 1 when response matches regex', async () => {
    expect(await regexScorer('abc123', { id: 't1', expected: '\\d+' })).toBe(1);
  });

  it('is case-insensitive', async () => {
    expect(await regexScorer('Hello World', { id: 't1', expected: 'hello' })).toBe(1);
  });

  it('returns 0 when response does not match', async () => {
    expect(await regexScorer('no numbers here', { id: 't1', expected: '\\d+' })).toBe(0);
  });

  it('returns 0 for invalid regex without throwing', async () => {
    expect(await regexScorer('anything', { id: 't1', expected: '[invalid' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseExpectedJsonl
// ---------------------------------------------------------------------------

describe('parseExpectedJsonl', () => {
  it('parses valid JSONL into a map', () => {
    const src = '{"id":"t1","expected":"hello"}\n{"id":"t2","expected":"world","match":"exact"}';
    const map = parseExpectedJsonl(src);
    expect(map.size).toBe(2);
    expect(map.get('t1')).toEqual({ id: 't1', expected: 'hello', match: undefined });
    expect(map.get('t2')).toEqual({ id: 't2', expected: 'world', match: 'exact' });
  });

  it('skips blank lines', () => {
    const src = '{"id":"t1","expected":"x"}\n\n{"id":"t2","expected":"y"}';
    expect(parseExpectedJsonl(src).size).toBe(2);
  });

  it('throws on missing required fields', () => {
    expect(() => parseExpectedJsonl('{"id":"t1"}')).toThrow('expected');
  });

  it('ignores unknown match values', () => {
    const src = '{"id":"t1","expected":"x","match":"unknown"}';
    const map = parseExpectedJsonl(src);
    expect(map.get('t1')?.match).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EvalRunner integration tests
// ---------------------------------------------------------------------------

describe('EvalRunner', () => {
  it('scores a passing task as 1 and failing task as 0', async () => {
    const outputPath = join(testDir, 'out.jsonl');
    const loop = makeLoop({ task1: 'The answer is 42', task2: 'No answer here' });
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath,
      defaultScorer: 'contains',
    });

    const tasks = [
      { id: 'task1', prompt: 'What is 6*7?' },
      { id: 'task2', prompt: 'What is 6*7?' },
    ];
    const expectedMap = parseExpectedJsonl(
      '{"id":"task1","expected":"42"}\n{"id":"task2","expected":"42"}',
    );

    const stats = await runner.run(tasks, expectedMap);
    expect(stats.total).toBe(2);
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.avgScore).toBe(0.5);

    const lines = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const assistantRecords = lines.filter((r) => r.role === 'assistant');
    expect(assistantRecords).toHaveLength(2);

    const task1 = assistantRecords.find((r) => r.task_id === 'task1');
    const task2 = assistantRecords.find((r) => r.task_id === 'task2');
    expect(task1?.score).toBe(1);
    expect(task2?.score).toBe(0);
  });

  it('records skill_files_used from context_meta event', async () => {
    const outputPath = join(testDir, 'out.jsonl');
    const loop = makeLoopWithMeta({ task1: 'answer' }, ['security.md', 'coding.md']);
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath,
      defaultScorer: 'contains',
    });

    const tasks = [{ id: 'task1', prompt: 'test' }];
    const expectedMap = parseExpectedJsonl('{"id":"task1","expected":"answer"}');

    await runner.run(tasks, expectedMap);

    const lines = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const rec = lines.find((r) => r.role === 'assistant');
    expect(rec?.skill_files_used).toEqual(['security.md', 'coding.md']);
  });

  it('uses per-record match type when set', async () => {
    const outputPath = join(testDir, 'out.jsonl');
    const loop = makeLoop({ task1: 'hello world' });
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath,
      defaultScorer: 'exact',
    });

    const tasks = [{ id: 'task1', prompt: 'say hello' }];
    // match:contains — "hello" is contained, so score=1 even though not exact
    const expectedMap = parseExpectedJsonl('{"id":"task1","expected":"hello","match":"contains"}');

    const stats = await runner.run(tasks, expectedMap);
    expect(stats.passed).toBe(1);

    const lines = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const rec = lines.find((r) => r.role === 'assistant');
    expect(rec?.scorer).toBe('contains');
  });

  it('scores 0 and records error when no expected entry exists', async () => {
    const outputPath = join(testDir, 'out.jsonl');
    const loop = makeLoop({ task1: 'some response' });
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath,
      defaultScorer: 'contains',
    });

    const tasks = [{ id: 'task1', prompt: 'test' }];
    const stats = await runner.run(tasks, new Map());
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(1);
  });
});
