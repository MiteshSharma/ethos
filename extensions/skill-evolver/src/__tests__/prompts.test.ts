import { describe, expect, it } from 'vitest';
import {
  parseNewSkillResponse,
  parseRewriteResponse,
  renderNewSkillPrompt,
  renderRewritePrompt,
} from '../prompts';
import type { NewSkillCandidate, RewriteCandidate } from '../types';

const sampleRewrite: RewriteCandidate = {
  fileName: 'json.md',
  currentContent: '# JSON\nWrite valid JSON.',
  stats: { fileName: 'json.md', runs: 12, avgScore: 0.3, scoreSum: 3.6 },
  lowScoringTasks: [
    {
      taskId: 't1',
      prompt: 'Output a JSON object with name and age.',
      response: '{name: alice, age: 30}',
      score: 0.0,
      skillFilesUsed: ['json.md'],
    },
    {
      taskId: 't2',
      prompt: 'Give me JSON for a todo list.',
      response: '[ todo1, todo2 ]',
      score: 0.2,
      skillFilesUsed: ['json.md'],
    },
  ],
};

const sampleNew: NewSkillCandidate = {
  tasks: [
    {
      taskId: 'a',
      prompt: 'Refactor this Python loop',
      response: 'used a list comprehension',
      score: 1,
      skillFilesUsed: [],
    },
    {
      taskId: 'b',
      prompt: 'Refactor this JS for-loop',
      response: 'used Array.map',
      score: 1,
      skillFilesUsed: [],
    },
    {
      taskId: 'c',
      prompt: 'Refactor this Ruby each',
      response: 'used .map',
      score: 1,
      skillFilesUsed: [],
    },
  ],
};

describe('renderRewritePrompt', () => {
  it('includes the current skill, score, and transcripts', () => {
    const out = renderRewritePrompt(sampleRewrite);
    expect(out).toContain('# JSON');
    expect(out).toContain('Write valid JSON.');
    expect(out).toContain('0.30');
    expect(out).toContain('12 runs');
    expect(out).toContain('Output a JSON object');
    expect(out).toContain('Give me JSON for a todo list');
    expect(out).toContain('<skill>');
    expect(out).toContain('NO_REWRITE');
  });

  it('clips long transcripts', () => {
    const big: RewriteCandidate = {
      ...sampleRewrite,
      lowScoringTasks: [
        {
          ...(sampleRewrite.lowScoringTasks[0] ?? {
            taskId: 'x',
            prompt: '',
            response: '',
            score: 0,
            skillFilesUsed: [],
          }),
          response: 'A'.repeat(2000),
        },
      ],
    };
    const out = renderRewritePrompt(big);
    expect(out).not.toContain('A'.repeat(1500));
    expect(out).toContain('…');
  });
});

describe('renderNewSkillPrompt', () => {
  it('lists all task transcripts and demands the filename+skill format', () => {
    const out = renderNewSkillPrompt(sampleNew);
    expect(out).toContain('3 task');
    expect(out).toContain('Refactor this Python loop');
    expect(out).toContain('Refactor this JS for-loop');
    expect(out).toContain('Refactor this Ruby each');
    expect(out).toContain('<filename>');
    expect(out).toContain('<skill>');
    expect(out).toContain('NO_PATTERN');
  });
});

describe('parseRewriteResponse', () => {
  it('extracts skill content from <skill> tags', () => {
    const r = parseRewriteResponse('<skill>\n# JSON\nUse strict JSON.\n</skill>');
    expect(r.kind).toBe('rewrite');
    if (r.kind === 'rewrite') expect(r.content).toBe('# JSON\nUse strict JSON.');
  });

  it('honors NO_REWRITE skip signal', () => {
    const r = parseRewriteResponse('NO_REWRITE');
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.reason).toBe('NO_REWRITE');
  });

  it('skips on malformed output', () => {
    const r = parseRewriteResponse('here is some skill: do better');
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.reason).toBe('malformed-output');
  });

  it('skips on empty skill body', () => {
    const r = parseRewriteResponse('<skill>   </skill>');
    expect(r.kind).toBe('skip');
  });
});

describe('parseNewSkillResponse', () => {
  it('extracts filename and content', () => {
    const r = parseNewSkillResponse(
      '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map.\n</skill>',
    );
    expect(r.kind).toBe('new');
    if (r.kind === 'new') {
      expect(r.fileName).toBe('map-over-loops.md');
      expect(r.content).toBe('Prefer map.');
    }
  });

  it('rejects unsafe filenames', () => {
    const r = parseNewSkillResponse('<filename>../etc/passwd</filename>\n<skill>x</skill>');
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.reason).toBe('invalid-filename');
  });

  it('rejects non-kebab filenames', () => {
    const r = parseNewSkillResponse('<filename>SomeSkill.md</filename>\n<skill>x</skill>');
    expect(r.kind).toBe('skip');
  });

  it('honors NO_PATTERN', () => {
    const r = parseNewSkillResponse('NO_PATTERN');
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.reason).toBe('NO_PATTERN');
  });
});
