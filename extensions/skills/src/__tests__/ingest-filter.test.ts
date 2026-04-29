import type { PersonalityConfig, Skill } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { filterSkill, warnMissingAllowList } from '../ingest-filter';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    qualifiedName: 'ethos/my-skill',
    name: 'My Skill',
    source: 'ethos',
    filePath: '/skills/my-skill.md',
    body: '# body',
    rawFrontmatter: {},
    dialect: 'agentskills',
    mtimeMs: 1_000_000,
    ...overrides,
  };
}

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'researcher',
    name: 'Researcher',
    toolset: ['read_file', 'search_web'],
    ...overrides,
  };
}

describe('filterSkill', () => {
  describe('capability mode (default)', () => {
    it('includes skill whose required_tools ⊆ toolNames', () => {
      const skill = makeSkill({ required_tools: ['read_file'] });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file', 'search_web']));
      expect(result.include).toBe(true);
    });

    it('excludes skill whose required_tools ⊄ toolNames', () => {
      const skill = makeSkill({ required_tools: ['run_shell'] });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('run_shell');
    });

    it('includes pure-prose skill (no required_tools) with default fallback', () => {
      const skill = makeSkill({ required_tools: undefined });
      const result = filterSkill(skill, makePersonality(), new Set());
      expect(result.include).toBe(true);
      expect(result.reason).toContain('pure prose');
    });

    it('excludes pure-prose skill when fallback is deny', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'capability', fallback_unknown: 'deny' } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
    });

    it('calls onWarn for fallback: warn', () => {
      const warn = vi.fn();
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'capability', fallback_unknown: 'warn' } },
      });
      filterSkill(makeSkill(), personality, new Set(), warn);
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('explicit mode', () => {
    it('excludes all skills not in allow list', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: [] } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
    });

    it('includes skill in allow list', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: ['ethos/my-skill'] } },
      });
      const result = filterSkill(makeSkill(), personality, new Set(['read_file']));
      expect(result.include).toBe(true);
    });

    it('rejects allow-listed skill whose required_tools are unreachable', () => {
      const warn = vi.fn();
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: ['ethos/my-skill'] } },
      });
      const skill = makeSkill({ required_tools: ['run_shell'] });
      const result = filterSkill(skill, personality, new Set(['read_file']), warn);
      expect(result.include).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('deny list', () => {
    it('deny always wins, even over explicit allow', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: {
            mode: 'explicit',
            allow: ['ethos/my-skill'],
            deny: ['ethos/my-skill'],
          },
        },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toBe('explicit deny');
    });
  });

  describe('tags mode', () => {
    it('includes skill with matching accept_tags', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: { mode: 'tags', accept_tags: ['research'] },
        },
      });
      const skill = makeSkill({ tags: ['research', 'web'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(true);
    });

    it('excludes skill with no matching accept_tags', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'tags', accept_tags: ['deploy'] } },
      });
      const skill = makeSkill({ tags: ['research'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
    });

    it('excludes skill with a reject_tag', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: {
            mode: 'tags',
            accept_tags: ['research'],
            reject_tags: ['ops'],
          },
        },
      });
      const skill = makeSkill({ tags: ['research', 'ops'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('ops');
    });

    it('includes untagged skill when no accept_tags configured', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'tags' } },
      });
      const result = filterSkill(makeSkill({ tags: undefined }), personality, new Set());
      expect(result.include).toBe(true);
    });
  });

  describe('none mode', () => {
    it('always excludes', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'none' } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toBe('mode: none');
    });
  });
});

describe('warnMissingAllowList', () => {
  it('warns for each allow-listed name missing from pool', () => {
    const warn = vi.fn();
    const pool = new Map([['ethos/present', {}]]);
    warnMissingAllowList('researcher', ['ethos/present', 'ethos/missing'], pool, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ethos/missing');
  });

  it('does not warn when all referenced skills exist', () => {
    const warn = vi.fn();
    const pool = new Map([
      ['ethos/a', {}],
      ['ethos/b', {}],
    ]);
    warnMissingAllowList('researcher', ['ethos/a', 'ethos/b'], pool, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
