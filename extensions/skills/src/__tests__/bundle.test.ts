import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UniversalScanner } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILL_IDS, bundledSkillsSource } from '../bundled';

const SOURCE = bundledSkillsSource();

describe('@ethosagent/skills bundle', () => {
  it('points at an existing data directory', () => {
    const stat = statSync(SOURCE.dir);
    expect(stat.isDirectory()).toBe(true);
    expect(SOURCE.label).toBe('ethos-bundled');
  });

  it('exposes a SKILL.md for every advertised skill id', () => {
    for (const id of BUNDLED_SKILL_IDS) {
      const skillMd = join(SOURCE.dir, id, 'SKILL.md');
      expect(statSync(skillMd).isFile(), `missing ${id}/SKILL.md`).toBe(true);
    }
  });

  it('every SKILL.md has the standard agentskills frontmatter', () => {
    for (const id of BUNDLED_SKILL_IDS) {
      const raw = readFileSync(join(SOURCE.dir, id, 'SKILL.md'), 'utf8');
      const { data } = matter(raw);
      expect(data.name, `${id} missing name`).toBeTruthy();
      expect(data.description, `${id} missing description`).toBeTruthy();
      expect(Array.isArray(data.tags), `${id} tags not array`).toBe(true);
      expect(Array.isArray(data.required_tools), `${id} required_tools not array`).toBe(true);
    }
  });

  it('every SKILL.md carries the ethos-specific extension block', () => {
    const validCategories = new Set([
      'planning-and-process',
      'quality-and-testing',
      'github-workflow',
      'delegation-and-orchestration',
      'research',
      // framework-usage covers meta-skills (`native-mcp`, `ethos-skill-authoring`)
      // — guidance for using or extending Ethos itself rather than executing a
      // coding workflow. Added in lockstep with the first-party skills that
      // depend on it.
      'framework-usage',
      // `writer` covers prose-craft skills (the `skills/writer/` tree). Added
      // with the first one advertised in BUNDLED_SKILL_IDS
      // (`writer/no-ai-slop`).
      'writer',
      // `platform-integration` covers skills that operate an external
      // platform's own CLI/API under the user's own account (e.g. X via
      // `xurl`) — distinct from `research` (broad, unauthenticated lookup)
      // and `github-workflow` (a specific existing category for one
      // platform). Added with the first one advertised in BUNDLED_SKILL_IDS
      // (`platform-integration/xurl`).
      'platform-integration',
    ]);
    for (const id of BUNDLED_SKILL_IDS) {
      const raw = readFileSync(join(SOURCE.dir, id, 'SKILL.md'), 'utf8');
      const { data } = matter(raw);
      const ethos = data.ethos as { category?: unknown; default_personalities?: unknown };
      expect(ethos, `${id} missing ethos block`).toBeTruthy();
      expect(
        validCategories.has(ethos.category as string),
        `${id} category is ${ethos.category}`,
      ).toBe(true);
      expect(Array.isArray(ethos.default_personalities), `${id} default_personalities`).toBe(true);
    }
  });

  it('coding-agent ships the four CLI adapters', () => {
    const adaptersDir = join(SOURCE.dir, 'software-development', 'coding-agent', 'adapters');
    const present = new Set(readdirSync(adaptersDir));
    for (const adapter of ['claude-code.md', 'codex.md', 'opencode.md', 'pi.md']) {
      expect(present.has(adapter), `missing adapter: ${adapter}`).toBe(true);
    }
  });

  it('arxiv skill ships the search script', () => {
    const scriptPath = join(SOURCE.dir, 'research', 'arxiv', 'scripts', 'search_arxiv.py');
    expect(statSync(scriptPath).isFile(), 'missing arxiv search script').toBe(true);
  });

  it('research-paper-writing ships citation and writing references', () => {
    const refsDir = join(SOURCE.dir, 'research', 'research-paper-writing', 'references');
    const present = new Set(readdirSync(refsDir));
    for (const ref of ['citation-workflow.md', 'writing-guide.md']) {
      expect(present.has(ref), `missing reference: ${ref}`).toBe(true);
    }
  });

  it('pi adapter documents the canonical one-shot invocation', () => {
    const piMd = readFileSync(
      join(SOURCE.dir, 'software-development', 'coding-agent', 'adapters', 'pi.md'),
      'utf8',
    );
    expect(piMd).toContain('pi -p');
  });

  it('universal scanner discovers all bundled skills via trustedFirstPartySources', async () => {
    const pool = await new UniversalScanner({
      storage: new FsStorage(),
      // disable default community sources so we don't scan the real ~/.ethos
      // / ~/.claude tree on the dev machine running these tests
      sources: [],
      trustedFirstPartySources: [SOURCE],
    }).scan();
    for (const id of BUNDLED_SKILL_IDS) {
      expect(pool.has(`ethos-bundled/${id}`), `scanner missed ${id}`).toBe(true);
    }
  });
});
