import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EVOLVE_CONFIG } from '../analyze';
import { SkillEvolver } from '../evolver';

let testDir: string;
let skillsDir: string;
let pendingDir: string;
let evalPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  skillsDir = join(testDir, 'skills');
  pendingDir = join(skillsDir, 'pending');
  evalPath = join(testDir, 'eval.jsonl');
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeLLM(responses: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      const text = responses[i++] ?? '';
      return (async function* () {
        yield { type: 'text_delta', text };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('SkillEvolver', () => {
  it('writes a rewritten skill to pending/', async () => {
    await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `q${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `a${i}`,
          score: 0.2,
          skill_files_used: ['json.md'],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['<skill>\nrewritten body\n</skill>']);

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      pendingDir,
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
    });

    const result = await evolver.evolve();
    expect(result.rewritesWritten).toEqual(['json.md']);

    const written = await readFile(join(pendingDir, 'json.md'), 'utf-8');
    expect(written).toContain('rewritten body');
  });

  it('writes a new skill from a high-score zero-skill bundle', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `prompt${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `answer${i}`,
          score: 1,
          skill_files_used: [],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM([
      '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map().\n</skill>',
    ]);

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      pendingDir,
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
    });

    const result = await evolver.evolve();
    expect(result.newSkillsWritten).toEqual(['map-over-loops.md']);
    const written = await readFile(join(pendingDir, 'map-over-loops.md'), 'utf-8');
    expect(written).toContain('Prefer map().');
  });

  it('records skip reason when LLM responds NO_REWRITE', async () => {
    await writeFile(join(skillsDir, 'a.md'), 'x', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push({
        schema_version: '1.0',
        task_id: `t${i}`,
        turn: 0,
        role: 'assistant',
        content: '',
        score: 0,
        skill_files_used: ['a.md'],
      });
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['NO_REWRITE']);
    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      pendingDir,
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
    });

    const result = await evolver.evolve();
    expect(result.rewritesWritten).toEqual([]);
    expect(result.skipped).toEqual([{ kind: 'rewrite', target: 'a.md', reason: 'NO_REWRITE' }]);

    const dirEntries = await readdir(pendingDir).catch(() => [] as string[]);
    expect(dirEntries).toEqual([]);
  });

  it('avoids overwriting an existing skill with a duplicate filename', async () => {
    await writeFile(join(skillsDir, 'shared.md'), 'preexisting', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push({
        schema_version: '1.0',
        task_id: `t${i}`,
        turn: 0,
        role: 'assistant',
        content: '',
        score: 1,
        skill_files_used: [],
      });
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['<filename>shared.md</filename>\n<skill>\nfresh\n</skill>']);
    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      pendingDir,
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
    });

    const result = await evolver.evolve();
    expect(result.newSkillsWritten).toEqual(['shared-2.md']);
    const original = await readFile(join(skillsDir, 'shared.md'), 'utf-8');
    expect(original).toBe('preexisting');
  });
});
