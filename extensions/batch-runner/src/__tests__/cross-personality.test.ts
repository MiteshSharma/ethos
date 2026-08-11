/**
 * The same task under two personalities must produce two sessions.
 *
 * A session's personality is bound at creation and immutable, so a session key
 * derived from the task id alone would bind on the first personality and get
 * every later one refused with `personality_locked` — which is exactly what an
 * A/B comparison of one task across personalities does.
 *
 * Driven against a REAL AgentLoop so the invariant, not a stub, is what's tested.
 */

import { join } from 'node:path';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import type { AtroposRecord, BatchTask } from '../index';
import { BatchRunner } from '../index';

function makeStubLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('BatchRunner across personalities', () => {
  it('gives the same task id its own session per personality', async () => {
    const storage = new InMemoryStorage();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const dir = '/batch-cross';
    await storage.mkdir(dir);

    const runOnce = async (personalityId: string, outputPath: string) => {
      const task: BatchTask = { id: 'shared-task', prompt: 'Hello', personalityId };
      const runner = new BatchRunner(
        loop,
        {
          concurrency: 1,
          defaultPersonalityId: 'researcher',
          outputPath,
          checkpointPath: join(dir, `${personalityId}-checkpoint.json`),
        },
        storage,
      );
      return runner.run([task]);
    };

    const first = await runOnce('researcher', join(dir, 'researcher.jsonl'));
    const second = await runOnce('engineer', join(dir, 'engineer.jsonl'));

    expect(first.completed).toBe(1);
    expect(first.failed).toBe(0);
    expect(second.completed).toBe(1);
    expect(second.failed).toBe(0);

    const sessions = await session.listSessions();
    expect(sessions.map((s) => s.key).sort()).toEqual([
      'batch:engineer:shared-task',
      'batch:researcher:shared-task',
    ]);
    expect(sessions.map((s) => s.personalityId).sort()).toEqual(['engineer', 'researcher']);

    // Neither run recorded a refusal, and both produced a real answer.
    for (const path of ['researcher.jsonl', 'engineer.jsonl']) {
      const src = (await storage.read(join(dir, path))) ?? '';
      const records = src
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AtroposRecord);
      const assistant = records.find((r) => r.role === 'assistant');
      expect(assistant?.error).toBeUndefined();
      expect(assistant?.content).toBe('answer');
    }
  });
});
