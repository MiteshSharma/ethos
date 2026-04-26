import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeEvalOutput,
  DEFAULT_EVOLVE_CONFIG,
  loadEvolveConfig,
  parseEvalJsonl,
} from '../analyze';
import type { EvalRecord } from '../types';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-evolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function recs(...lines: Partial<EvalRecord>[]): string {
  return lines
    .map((l) =>
      JSON.stringify({
        schema_version: '1.0',
        task_id: l.task_id ?? 't',
        turn: l.turn ?? 0,
        role: l.role ?? 'assistant',
        content: l.content ?? '',
        ...l,
      }),
    )
    .join('\n');
}

describe('parseEvalJsonl', () => {
  it('parses well-formed records', () => {
    const src = recs(
      { task_id: 't1', role: 'user', content: 'q1' },
      { task_id: 't1', role: 'assistant', content: 'a1', score: 0.9 },
    );
    const out = parseEvalJsonl(src);
    expect(out).toHaveLength(2);
    expect(out[0]?.task_id).toBe('t1');
    expect(out[1]?.score).toBe(0.9);
  });

  it('ignores blank lines', () => {
    const src = `\n${recs({ task_id: 't1', role: 'user', content: 'x' })}\n\n`;
    expect(parseEvalJsonl(src)).toHaveLength(1);
  });

  it('throws on invalid JSON with line number', () => {
    expect(() => parseEvalJsonl('{not json}')).toThrow(/Line 1/);
  });

  it('throws on missing required fields', () => {
    expect(() => parseEvalJsonl('{"task_id":"x"}')).toThrow(/Line 1/);
  });
});

describe('loadEvolveConfig', () => {
  it('returns defaults when file is missing', async () => {
    const cfg = await loadEvolveConfig(join(testDir, 'nope.json'));
    expect(cfg).toEqual(DEFAULT_EVOLVE_CONFIG);
  });

  it('merges partial config over defaults', async () => {
    const path = join(testDir, 'evolve-config.json');
    await writeFile(path, JSON.stringify({ rewriteThreshold: 0.5 }), 'utf-8');
    const cfg = await loadEvolveConfig(path);
    expect(cfg.rewriteThreshold).toBe(0.5);
    expect(cfg.minRunsBeforeEvolve).toBe(DEFAULT_EVOLVE_CONFIG.minRunsBeforeEvolve);
  });
});

describe('analyzeEvalOutput', () => {
  it('aggregates per-skill stats from skill_files_used', async () => {
    const src = recs(
      { task_id: 't1', role: 'user', content: 'q1' },
      {
        task_id: 't1',
        role: 'assistant',
        content: 'a1',
        score: 1,
        skill_files_used: ['a.md', 'b.md'],
      },
      { task_id: 't2', role: 'user', content: 'q2' },
      { task_id: 't2', role: 'assistant', content: 'a2', score: 0, skill_files_used: ['a.md'] },
    );
    const records = parseEvalJsonl(src);
    const plan = await analyzeEvalOutput(records, testDir, DEFAULT_EVOLVE_CONFIG);

    const a = plan.skillStats.find((s) => s.fileName === 'a.md');
    const b = plan.skillStats.find((s) => s.fileName === 'b.md');
    expect(a?.runs).toBe(2);
    expect(a?.avgScore).toBe(0.5);
    expect(b?.runs).toBe(1);
    expect(b?.avgScore).toBe(1);
  });

  it('skips errored tasks', async () => {
    const src = recs(
      { task_id: 't1', role: 'user', content: 'q' },
      {
        task_id: 't1',
        role: 'assistant',
        content: '',
        score: 0,
        skill_files_used: ['a.md'],
        error: 'boom',
      },
    );
    const plan = await analyzeEvalOutput(parseEvalJsonl(src), testDir, DEFAULT_EVOLVE_CONFIG);
    expect(plan.skillStats).toHaveLength(0);
  });

  it('flags rewrite candidate only when runs >= minRunsBeforeEvolve and avg < threshold', async () => {
    // 12 tasks, all using a.md, all scoring 0.3 → below 0.6 default
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `q${i}`,
        }),
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `a${i}`,
          score: 0.3,
          skill_files_used: ['low.md'],
        }),
      );
    }
    await writeFile(join(testDir, 'low.md'), '# low skill', 'utf-8');
    const plan = await analyzeEvalOutput(
      parseEvalJsonl(lines.join('\n')),
      testDir,
      DEFAULT_EVOLVE_CONFIG,
    );
    expect(plan.rewriteCandidates).toHaveLength(1);
    expect(plan.rewriteCandidates[0]?.fileName).toBe('low.md');
    expect(plan.rewriteCandidates[0]?.currentContent).toContain('low skill');
  });

  it('does not flag rewrite when runs are below minRunsBeforeEvolve', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: '',
          score: 0,
          skill_files_used: ['low.md'],
        }),
      );
    }
    await writeFile(join(testDir, 'low.md'), 'x', 'utf-8');
    const plan = await analyzeEvalOutput(
      parseEvalJsonl(lines.join('\n')),
      testDir,
      DEFAULT_EVOLVE_CONFIG,
    );
    expect(plan.rewriteCandidates).toHaveLength(0);
  });

  it('skips rewrite candidate when skill file is missing on disk', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: '',
          score: 0,
          skill_files_used: ['missing.md'],
        }),
      );
    }
    const plan = await analyzeEvalOutput(
      parseEvalJsonl(lines.join('\n')),
      testDir,
      DEFAULT_EVOLVE_CONFIG,
    );
    expect(plan.rewriteCandidates).toHaveLength(0);
  });

  it('bundles high-score zero-skill tasks when count >= minPatternCount', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `q${i}`,
        }),
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `a${i}`,
          score: 1,
          skill_files_used: [],
        }),
      );
    }
    const plan = await analyzeEvalOutput(
      parseEvalJsonl(lines.join('\n')),
      testDir,
      DEFAULT_EVOLVE_CONFIG,
    );
    expect(plan.newSkillCandidates).toHaveLength(1);
    expect(plan.newSkillCandidates[0]?.tasks).toHaveLength(4);
  });

  it('does not bundle when count < minPatternCount', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      lines.push(
        JSON.stringify({
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: '',
          score: 1,
          skill_files_used: [],
        }),
      );
    }
    const plan = await analyzeEvalOutput(
      parseEvalJsonl(lines.join('\n')),
      testDir,
      DEFAULT_EVOLVE_CONFIG,
    );
    expect(plan.newSkillCandidates).toHaveLength(0);
  });
});
