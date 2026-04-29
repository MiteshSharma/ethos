/**
 * End-to-end integration tests for Phase 1.1 + 1.2.
 *
 * Mirrors the step-by-step testing guide exactly — each `describe` block
 * corresponds to a numbered step. Uses InMemoryStorage so no real ~/.ethos/
 * or ~/.claude/ dirs are touched.
 */
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { filterSkill } from '../ingest-filter';
import { UniversalScanner } from '../universal-scanner';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ETHOS_SKILLS = '/home/ethos/skills';
const CLAUDE_SKILLS = '/home/claude/skills';
const OPENCLAW_SKILLS = '/home/openclaw/skills';

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return { id: 'default', name: 'Default', ...overrides };
}

function makeStorage(): InMemoryStorage {
  return new InMemoryStorage();
}

function makeScanner(storage: InMemoryStorage) {
  return new UniversalScanner({
    storage,
    sources: [
      { label: 'ethos', dir: ETHOS_SKILLS },
      { label: 'claude-code', dir: CLAUDE_SKILLS },
      { label: 'openclaw', dir: OPENCLAW_SKILLS },
    ],
  });
}

// Markdown for each test skill
const SUMMARIZE_DOC = `---
name: Summarize Document
description: Summarize a long document with section breakdown
tags: [summarize, productivity]
required_tools: [read_file]
---
When asked to summarize, read the file and write a 3-section breakdown.`;

const DEPLOY_PROD = `---
name: Deploy to Production
description: Deploy current branch to production
tags: [deploy, ops]
required_tools: [run_shell, ssh_connect]
---
Run the deployment pipeline and monitor for errors.`;

const CITATION_FORMATTER = `---
name: Citation Formatter
description: Format inline citations to APA/MLA/Chicago
tags: [research, citation, web]
required_tools: [read_file]
---
When given raw notes with URLs, format them as proper APA citations.`;

const OPENCLAW_BASH = `---
name: Bash Helper
tags: [shell, terminal]
metadata:
  openclaw:
    requires:
      bins: [bash]
---
Do shell things.`;

// ---------------------------------------------------------------------------
// Step 2 — single skill in ethos global pool
// ---------------------------------------------------------------------------

describe('Step 2 — ethos global skill visible to default personality', () => {
  let storage: InMemoryStorage;

  beforeEach(async () => {
    storage = makeStorage();
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);
  });

  it('scanner discovers the skill with qualified name ethos/summarize-doc', async () => {
    const pool = await makeScanner(storage).scan();
    expect(pool.has('ethos/summarize-doc')).toBe(true);
    const skill = pool.get('ethos/summarize-doc')!;
    expect(skill.name).toBe('Summarize Document');
    expect(skill.required_tools).toEqual(['read_file']);
    expect(skill.dialect).toBe('agentskills');
  });

  it('capability filter includes skill when toolset contains read_file', () => {
    const pool = new Map([
      [
        'ethos/summarize-doc',
        {
          qualifiedName: 'ethos/summarize-doc',
          required_tools: ['read_file'],
          name: 'Summarize Document',
          source: 'ethos',
          filePath: '/p',
          body: '',
          rawFrontmatter: {},
          dialect: 'agentskills' as const,
          mtimeMs: 1,
        },
      ],
    ]);
    const personality = makePersonality({ toolset: ['read_file', 'search_web'] });
    const toolNames = new Set(['read_file', 'search_web']);
    for (const [, skill] of pool) {
      const result = filterSkill(skill, personality, toolNames);
      expect(result.include).toBe(true);
      expect(result.reason).toContain('capability');
    }
  });
});

// ---------------------------------------------------------------------------
// Step 3 — capability filtering by toolset
// ---------------------------------------------------------------------------

describe('Step 3 — capability filtering (researcher vs engineer)', () => {
  let storage: InMemoryStorage;
  let scanner: UniversalScanner;

  beforeEach(async () => {
    storage = makeStorage();
    scanner = makeScanner(storage);
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);
    await storage.write(`${ETHOS_SKILLS}/deploy-prod.md`, DEPLOY_PROD);
  });

  it('researcher (no run_shell) sees summarize-doc but not deploy-prod', async () => {
    const pool = await scanner.scan();
    const researcher = makePersonality({ id: 'researcher', toolset: ['read_file', 'search_web'] });
    const toolNames = new Set(['read_file', 'search_web']);

    const summarize = pool.get('ethos/summarize-doc')!;
    const deploy = pool.get('ethos/deploy-prod')!;

    expect(filterSkill(summarize, researcher, toolNames).include).toBe(true);
    expect(filterSkill(deploy, researcher, toolNames).include).toBe(false);
    expect(filterSkill(deploy, researcher, toolNames).reason).toContain('run_shell');
  });

  it('engineer (has run_shell + ssh_connect) sees both skills', async () => {
    const pool = await scanner.scan();
    const engineer = makePersonality({
      id: 'engineer',
      toolset: ['read_file', 'write_file', 'run_shell', 'search_web', 'ssh_connect'],
    });
    const toolNames = new Set(engineer.toolset!);

    const summarize = pool.get('ethos/summarize-doc')!;
    const deploy = pool.get('ethos/deploy-prod')!;

    expect(filterSkill(summarize, engineer, toolNames).include).toBe(true);
    expect(filterSkill(deploy, engineer, toolNames).include).toBe(true);
  });

  it('reject reason names the missing tool', async () => {
    const pool = await scanner.scan();
    const researcher = makePersonality({ toolset: ['read_file'] });
    const deploy = pool.get('ethos/deploy-prod')!;
    const result = filterSkill(deploy, researcher, new Set(['read_file']));
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/run_shell|ssh_connect/);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — explicit mode
// ---------------------------------------------------------------------------

describe('Step 4 — explicit mode allow list', () => {
  let storage: InMemoryStorage;
  let scanner: UniversalScanner;

  beforeEach(async () => {
    storage = makeStorage();
    scanner = makeScanner(storage);
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);
    await storage.write(`${ETHOS_SKILLS}/deploy-prod.md`, DEPLOY_PROD);
  });

  it('explicit mode with only summarize-doc in allow: shows just that skill', async () => {
    const pool = await scanner.scan();
    const researcher = makePersonality({
      id: 'researcher',
      skills: { global_ingest: { mode: 'explicit', allow: ['ethos/summarize-doc'] } },
    });
    const toolNames = new Set(['read_file', 'search_web']);

    const summarize = pool.get('ethos/summarize-doc')!;
    const deploy = pool.get('ethos/deploy-prod')!;

    expect(filterSkill(summarize, researcher, toolNames).include).toBe(true);
    expect(filterSkill(deploy, researcher, toolNames).include).toBe(false);
    expect(filterSkill(deploy, researcher, toolNames).reason).toBe(
      'not in allow list (mode: explicit)',
    );
  });

  it('missing-reference warning fires for allow-listed skill absent from pool', async () => {
    const pool = await scanner.scan();
    const warnings: string[] = [];
    const { warnMissingAllowList } = await import('../ingest-filter');
    warnMissingAllowList('researcher', ['ethos/summarize-doc', 'ethos/nonexistent'], pool, (m) =>
      warnings.push(m),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ethos/nonexistent');
    expect(warnings[0]).toContain('not found in any source');
  });

  it('empty allow list in explicit mode blocks all global pool skills', async () => {
    const pool = await scanner.scan();
    const researcher = makePersonality({
      skills: { global_ingest: { mode: 'explicit', allow: [] } },
    });
    for (const [, skill] of pool) {
      expect(filterSkill(skill, researcher, new Set()).include).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 5 — cross-source discovery (Claude Code format)
// ---------------------------------------------------------------------------

describe('Step 5 — cross-source discovery from ~/.claude/skills/', () => {
  let storage: InMemoryStorage;
  let scanner: UniversalScanner;

  beforeEach(async () => {
    storage = makeStorage();
    scanner = makeScanner(storage);
    await storage.mkdir(ETHOS_SKILLS);
    await storage.mkdir(CLAUDE_SKILLS);
    await storage.write(`${CLAUDE_SKILLS}/citation-formatter.md`, CITATION_FORMATTER);
  });

  it('discovers citation-formatter from claude-code source', async () => {
    const pool = await scanner.scan();
    expect(pool.has('claude-code/citation-formatter')).toBe(true);
    const skill = pool.get('claude-code/citation-formatter')!;
    expect(skill.name).toBe('Citation Formatter');
    expect(skill.source).toBe('claude-code');
    expect(skill.tags).toContain('research');
  });

  it('researcher with read_file can access claude-code skill', () => {
    const skill = {
      qualifiedName: 'claude-code/citation-formatter',
      required_tools: ['read_file'],
      name: 'Citation Formatter',
      source: 'claude-code',
      filePath: `${CLAUDE_SKILLS}/citation-formatter.md`,
      body: 'Format citations.',
      tags: ['research', 'citation'],
      rawFrontmatter: {},
      dialect: 'agentskills' as const,
      mtimeMs: 1,
    };
    const researcher = makePersonality({ toolset: ['read_file', 'search_web'] });
    const result = filterSkill(skill, researcher, new Set(['read_file', 'search_web']));
    expect(result.include).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 5b — OpenClaw format from ~/.openclaw/skills/
// ---------------------------------------------------------------------------

describe('Step 5b — OpenClaw dialect from ~/.openclaw/skills/', () => {
  it('scanner detects and labels openclaw dialect', async () => {
    const storage = makeStorage();
    await storage.mkdir(OPENCLAW_SKILLS);
    await storage.mkdir(`${OPENCLAW_SKILLS}/bash-helper`);
    await storage.write(`${OPENCLAW_SKILLS}/bash-helper/SKILL.md`, OPENCLAW_BASH);

    const pool = await makeScanner(storage).scan();
    expect(pool.has('openclaw/bash-helper')).toBe(true);
    const skill = pool.get('openclaw/bash-helper')!;
    expect(skill.dialect).toBe('openclaw');
    expect(skill.name).toBe('Bash Helper');
  });
});

// ---------------------------------------------------------------------------
// Step 6 — none mode disables global pool
// ---------------------------------------------------------------------------

describe('Step 6 — none mode disables global pool', () => {
  it('none mode excludes all skills regardless of toolset', async () => {
    const storage = makeStorage();
    const scanner = makeScanner(storage);
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);

    const pool = await scanner.scan();
    const researcher = makePersonality({
      toolset: ['read_file', 'search_web'],
      skills: { global_ingest: { mode: 'none' } },
    });

    for (const [, skill] of pool) {
      expect(filterSkill(skill, researcher, new Set(['read_file'])).include).toBe(false);
      expect(filterSkill(skill, researcher, new Set(['read_file'])).reason).toBe('mode: none');
    }
  });
});

// ---------------------------------------------------------------------------
// Deduplication — first source wins
// ---------------------------------------------------------------------------

describe('Deduplication — first source wins on name collision', () => {
  it('ethos source beats claude-code when both have same slug', async () => {
    const storage = makeStorage();
    await storage.mkdir(ETHOS_SKILLS);
    await storage.mkdir(CLAUDE_SKILLS);

    const ethosVersion = `---
name: From Ethos
required_tools: [read_file]
---
Ethos body.`;

    const claudeVersion = `---
name: From Claude
required_tools: [read_file]
---
Claude body.`;

    // Both use the same file name → same qualified name after labelling
    // ethos/summarize-doc wins because ethos comes first in sources list
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, ethosVersion);
    await storage.write(`${CLAUDE_SKILLS}/summarize-doc.md`, claudeVersion);

    const scanner = new UniversalScanner({
      storage,
      sources: [
        { label: 'ethos', dir: ETHOS_SKILLS },
        { label: 'claude-code', dir: CLAUDE_SKILLS },
      ],
    });
    const pool = await scanner.scan();

    // Both get separate qualified names (ethos/ vs claude-code/)
    expect(pool.has('ethos/summarize-doc')).toBe(true);
    expect(pool.has('claude-code/summarize-doc')).toBe(true);
    expect(pool.get('ethos/summarize-doc')!.name).toBe('From Ethos');
    expect(pool.get('claude-code/summarize-doc')!.name).toBe('From Claude');
  });
});

// ---------------------------------------------------------------------------
// mtime cache — re-reads only when file changes
// ---------------------------------------------------------------------------

describe('mtime cache — scanner re-reads only when file changes', () => {
  it('returns same Skill object on second scan when file unchanged', async () => {
    const storage = makeStorage();
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);

    const scanner = makeScanner(storage);
    const pool1 = await scanner.scan();
    const pool2 = await scanner.scan();

    expect(pool1.get('ethos/summarize-doc')).toBe(pool2.get('ethos/summarize-doc'));
  });

  it('re-reads file after mtime changes', async () => {
    const storage = makeStorage();
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC);

    const scanner = makeScanner(storage);
    const pool1 = await scanner.scan();
    const firstSkill = pool1.get('ethos/summarize-doc')!;

    // Overwrite changes mtime in InMemoryStorage
    await storage.write(`${ETHOS_SKILLS}/summarize-doc.md`, SUMMARIZE_DOC + '\nUpdated.');
    const pool2 = await scanner.scan();
    const secondSkill = pool2.get('ethos/summarize-doc')!;

    expect(secondSkill).not.toBe(firstSkill);
    expect(secondSkill.body).toContain('Updated');
  });
});

// ---------------------------------------------------------------------------
// Legacy skills (no frontmatter) still load
// ---------------------------------------------------------------------------

describe('Legacy plain-markdown skills (no frontmatter)', () => {
  it('pure markdown with no frontmatter is parsed as legacy dialect', async () => {
    const storage = makeStorage();
    await storage.mkdir(ETHOS_SKILLS);
    await storage.write(`${ETHOS_SKILLS}/old-style.md`, '# Old skill\n\nDo the thing.');

    const pool = await makeScanner(storage).scan();
    expect(pool.has('ethos/old-style')).toBe(true);
    const skill = pool.get('ethos/old-style')!;
    expect(skill.dialect).toBe('legacy');
    expect(skill.required_tools).toBeUndefined();
  });

  it('capability filter includes legacy skill (no required_tools = pure prose)', () => {
    const skill = {
      qualifiedName: 'ethos/old-style',
      name: 'old-style',
      source: 'ethos',
      filePath: '/p',
      body: '# Old skill',
      rawFrontmatter: {},
      dialect: 'legacy' as const,
      mtimeMs: 1,
    };
    const result = filterSkill(skill, makePersonality(), new Set());
    expect(result.include).toBe(true);
    expect(result.reason).toContain('pure prose');
  });
});
