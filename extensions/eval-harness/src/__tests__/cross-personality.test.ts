/**
 * The same eval task under two personalities must produce two sessions.
 *
 * A session's personality is bound at creation and immutable, so a session key
 * derived from the task id alone would bind on the first personality and get
 * every later one refused with `personality_locked` — which is exactly what a
 * cross-personality eval does.
 *
 * Driven against a REAL AgentLoop so the invariant, not a stub, is what's tested.
 */

import { join } from 'node:path';
import type { BatchTask } from '@ethosagent/batch-runner';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { EvalRunner } from '../runner';
import type { EvalExpected } from '../types';

function makeStubLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'the answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('EvalRunner across personalities', () => {
  it('gives the same task id its own session per personality', async () => {
    const storage = new InMemoryStorage();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const dir = '/eval-cross';
    await storage.mkdir(dir);

    const expectedMap = new Map<string, EvalExpected>([
      ['shared-task', { id: 'shared-task', expected: 'the answer' }],
    ]);

    const runOnce = async (personalityId: string) => {
      const task: BatchTask = { id: 'shared-task', prompt: 'Question?', personalityId };
      const runner = new EvalRunner(loop, {
        concurrency: 1,
        outputPath: join(dir, `${personalityId}.jsonl`),
        defaultScorer: 'contains',
        storage,
      });
      return runner.run([task], expectedMap);
    };

    // Both runs score 1 — a refused turn would produce no text and score 0.
    expect((await runOnce('researcher')).passed).toBe(1);
    expect((await runOnce('engineer')).passed).toBe(1);

    const sessions = await session.listSessions();
    expect(sessions.map((s) => s.key).sort()).toEqual([
      'eval:engineer:shared-task',
      'eval:researcher:shared-task',
    ]);
    expect(sessions.map((s) => s.personalityId).sort()).toEqual(['engineer', 'researcher']);
  });

  it('keeps the plain eval:<id> key for a task that names no personality', async () => {
    const storage = new InMemoryStorage();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const dir = '/eval-default';
    await storage.mkdir(dir);

    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath: join(dir, 'out.jsonl'),
      defaultScorer: 'contains',
      storage,
    });
    await runner.run(
      [{ id: 'plain-task', prompt: 'Question?' }],
      new Map([['plain-task', { id: 'plain-task', expected: 'the answer' }]]),
    );

    expect((await session.listSessions()).map((s) => s.key)).toEqual(['eval:plain-task']);
  });
});
