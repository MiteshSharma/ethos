import type { Tool, ToolContext } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSkillsTools,
  type PendingSkillSummary,
  type PendingSkillsPort,
  type SkillsToolsOptions,
} from '../index';

// A stand-in for SkillsLibrary's pending slice: records the ids it was called
// with so the tools can be checked for pass-through, and throws the same shape
// of error the real library throws for an unknown id.
class FakePendingLibrary implements PendingSkillsPort {
  approved: string[] = [];
  rejected: string[] = [];

  constructor(private items: PendingSkillSummary[] = []) {}

  async listPending(): Promise<PendingSkillSummary[]> {
    return this.items;
  }

  async approvePending(id: string): Promise<void> {
    if (!this.items.some((p) => p.id === id)) throw new Error(`Skill "${id}" not found.`);
    this.approved.push(id);
    this.items = this.items.filter((p) => p.id !== id);
  }

  async rejectPending(id: string): Promise<void> {
    if (!this.items.some((p) => p.id === id)) throw new Error(`Skill "${id}" not found.`);
    this.rejected.push(id);
    this.items = this.items.filter((p) => p.id !== id);
  }
}

function pending(id: string, name: string): PendingSkillSummary {
  return {
    id,
    name,
    description: `${name} description`,
    body: `# ${name}\n\nbody of ${id}\n`,
    proposedAt: '2026-08-01T10:00:00.000Z',
  };
}

const ctx = {} as ToolContext;

let library: FakePendingLibrary;
let tools: Tool[];

function build(items: PendingSkillSummary[]): void {
  library = new FakePendingLibrary(items);
  const opts: SkillsToolsOptions = {
    listSkills: () => [],
    getSkillContent: () => null,
    pending: library,
  };
  tools = createSkillsTools(opts);
}

function tool(name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

beforeEach(() => {
  build([pending('new-1754-abc123', 'Tighten prose'), pending('new-1754-def456', 'Bisect flakes')]);
});

describe('skills_pending_list', () => {
  it('reports an empty queue as a normal result', async () => {
    build([]);
    const result = await tool('skills_pending_list').execute({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('No proposed skills');
  });

  it('lists every candidate with its id, name and proposed timestamp', async () => {
    const result = await tool('skills_pending_list').execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('2 proposed skill(s)');
    expect(result.value).toContain('Tighten prose');
    expect(result.value).toContain('new-1754-abc123');
    expect(result.value).toContain('Bisect flakes');
    expect(result.value).toContain('2026-08-01T10:00:00.000Z');
  });
});

describe('skills_pending_view', () => {
  it('returns the full body of a valid id', async () => {
    const result = await tool('skills_pending_view').execute({ id: 'new-1754-abc123' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Tighten prose');
    expect(result.value).toContain('body of new-1754-abc123');
  });

  it('returns a typed error for an unknown id', async () => {
    const result = await tool('skills_pending_view').execute({ id: 'no-such-skill' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
  });
});

describe('skills_pending_approve', () => {
  it('calls the library with the id it was given', async () => {
    const result = await tool('skills_pending_approve').execute({ id: 'new-1754-abc123' }, ctx);
    expect(result.ok).toBe(true);
    expect(library.approved).toEqual(['new-1754-abc123']);
    expect(library.rejected).toEqual([]);
  });

  it('returns a typed error rather than throwing for an unknown id', async () => {
    const result = await tool('skills_pending_approve').execute({ id: 'gone' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(library.approved).toEqual([]);
  });

  it('returns a typed error for an already-approved id', async () => {
    await tool('skills_pending_approve').execute({ id: 'new-1754-abc123' }, ctx);
    const second = await tool('skills_pending_approve').execute({ id: 'new-1754-abc123' }, ctx);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('not_available');
    expect(library.approved).toEqual(['new-1754-abc123']);
  });
});

describe('skills_pending_reject', () => {
  it('calls the library with the id it was given', async () => {
    const result = await tool('skills_pending_reject').execute({ id: 'new-1754-def456' }, ctx);
    expect(result.ok).toBe(true);
    expect(library.rejected).toEqual(['new-1754-def456']);
    expect(library.approved).toEqual([]);
  });
});

describe('id validation', () => {
  // Same charset guard SkillsLibrary applies before joining an id into a path.
  const unsafe = ['../../etc/passwd', 'Foo', 'a b', '', '.pending'];

  for (const name of ['skills_pending_view', 'skills_pending_approve', 'skills_pending_reject']) {
    it(`${name} refuses an id that fails validation`, async () => {
      for (const id of unsafe) {
        const result = await tool(name).execute({ id }, ctx);
        expect(result.ok, `expected ${name} to refuse "${id}"`).toBe(false);
        if (result.ok) continue;
        expect(result.code).toBe('input_invalid');
      }
      expect(library.approved).toEqual([]);
      expect(library.rejected).toEqual([]);
    });
  }
});

describe('approval gate', () => {
  it('marks approve and reject requiresApproval so the confirm path runs', () => {
    expect(tool('skills_pending_approve').requiresApproval).toBe(true);
    expect(tool('skills_pending_reject').requiresApproval).toBe(true);
  });

  it('leaves the read-only pending tools ungated', () => {
    expect(tool('skills_pending_list').requiresApproval).toBeFalsy();
    expect(tool('skills_pending_view').requiresApproval).toBeFalsy();
  });

  it('gates every pending tool behind the skills toolset', () => {
    for (const name of [
      'skills_pending_list',
      'skills_pending_view',
      'skills_pending_approve',
      'skills_pending_reject',
    ]) {
      expect(tool(name).toolset).toBe('skills');
    }
  });
});
