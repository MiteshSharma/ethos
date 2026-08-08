/**
 * `SkillsInjector.resolveRenderers` — the renderer-capability derivation the
 * web surface consults before upgrading a fenced block to an interactive
 * renderer (skill-declared-renderers, Lane C).
 *
 * The two skill sources reach `renders` by different routes, so both are
 * asserted: global-pool skills carry the typed `Skill.renders` from the
 * universal scanner, while per-personality `skills/` entries carry only a
 * filePath and must be frontmatter-parsed by the injector itself.
 */
import { dirname } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { SkillsInjector } from '../skills-injector';
import { UniversalScanner } from '../universal-scanner';

const GLOBAL_DIR = '/pool/skills';
const PERSONALITY_DIR = '/home/p/skills';

const CHARTS_MD = `---
name: charts
description: Show data as an interactive chart inline in chat.
tags: [document, chart]
required_tools: []

ethos:
  category: document
  renders: ['echarts@1']
---
Emit a fenced echarts block containing a pure-JSON option object.`;

const PLAIN_MD = `---
name: notes
description: Take notes.
required_tools: []
---
Write things down.`;

const MERMAID_MD = `---
name: diagrams
description: Draw diagrams.
required_tools: []

ethos:
  renders: ['mermaid@2']
---
Draw a diagram.`;

/** InMemoryStorage.write requires an existing parent — mkdir it first. */
async function put(storage: InMemoryStorage, path: string, content: string): Promise<void> {
  await storage.mkdir(dirname(path));
  await storage.write(path, content);
}

function makeRegistry(skillsDirs: string[]) {
  const personality: PersonalityConfig = { id: 'researcher', name: 'Researcher', skillsDirs };
  return {
    define: () => {},
    get: (_id: string) => personality,
    list: () => [personality],
    getDefault: () => personality,
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
}

function makeInjector(storage: InMemoryStorage, skillsDirs: string[]) {
  return new SkillsInjector(makeRegistry(skillsDirs), {
    storage,
    globalSkillsDir: GLOBAL_DIR,
    // Hermetic: only the in-memory pool dir, never the dev machine's real
    // ~/.ethos/skills or ~/.claude/skills.
    scanner: new UniversalScanner({ storage, sources: [{ label: 'test', dir: GLOBAL_DIR }] }),
  });
}

describe('SkillsInjector.resolveRenderers', () => {
  it('reads the typed renders field off a global-pool skill', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${GLOBAL_DIR}/charts/SKILL.md`, CHARTS_MD);

    const injector = makeInjector(storage, []);
    expect(await injector.resolveRenderers('researcher')).toEqual(['echarts@1']);
  });

  it('parses renders out of a per-personality flat .md copy', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${PERSONALITY_DIR}/charts.md`, CHARTS_MD);

    const injector = makeInjector(storage, [PERSONALITY_DIR]);
    expect(await injector.resolveRenderers('researcher')).toEqual(['echarts@1']);
  });

  it('finds a directory-form per-personality install (skills/<id>/SKILL.md)', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${PERSONALITY_DIR}/charts/SKILL.md`, CHARTS_MD);

    const injector = makeInjector(storage, [PERSONALITY_DIR]);
    expect(await injector.resolveRenderers('researcher')).toEqual(['echarts@1']);
  });

  it('finds a scoped per-personality install (skills/<scope>/<id>/SKILL.md)', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${PERSONALITY_DIR}/document/charts/SKILL.md`, CHARTS_MD);

    const injector = makeInjector(storage, [PERSONALITY_DIR]);
    expect(await injector.resolveRenderers('researcher')).toEqual(['echarts@1']);
  });

  it('returns an empty array when no resolved skill declares a renderer', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${GLOBAL_DIR}/notes/SKILL.md`, PLAIN_MD);
    await put(storage, `${PERSONALITY_DIR}/notes.md`, PLAIN_MD);

    const injector = makeInjector(storage, [PERSONALITY_DIR]);
    expect(await injector.resolveRenderers('researcher')).toEqual([]);
  });

  it('returns an empty array when the personality has no skills at all', async () => {
    const storage = new InMemoryStorage();
    const injector = makeInjector(storage, []);
    expect(await injector.resolveRenderers('researcher')).toEqual([]);
  });

  it('unions both sources, deduplicated and sorted', async () => {
    const storage = new InMemoryStorage();
    await put(storage, `${GLOBAL_DIR}/diagrams/SKILL.md`, MERMAID_MD);
    // Same renderer declared by a global skill AND a personality-dir skill —
    // one entry out, not two.
    await put(storage, `${GLOBAL_DIR}/charts/SKILL.md`, CHARTS_MD);
    await put(storage, `${PERSONALITY_DIR}/charts.md`, CHARTS_MD);

    const injector = makeInjector(storage, [PERSONALITY_DIR]);
    expect(await injector.resolveRenderers('researcher')).toEqual(['echarts@1', 'mermaid@2']);
  });
});
