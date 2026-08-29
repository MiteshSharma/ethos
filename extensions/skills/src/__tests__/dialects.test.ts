import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { canParse as agentCan, parseAgentSkills } from '../dialects/agentskills';
import { canParse as hermesCan, parseHermes } from '../dialects/hermes';
import { canParse as clawCan, parseOpenClaw } from '../dialects/openclaw';
import { UniversalScanner } from '../universal-scanner';

const MTIME = 1_000_000;

describe('agentskills dialect', () => {
  it('canParse when required_tools present', () => {
    expect(agentCan({ required_tools: ['read_file'] })).toBe(true);
  });

  it('canParse when tags present', () => {
    expect(agentCan({ tags: ['research'] })).toBe(true);
  });

  it('canParse when description present', () => {
    expect(agentCan({ description: 'does something' })).toBe(true);
  });

  it('rejects empty frontmatter', () => {
    expect(agentCan({})).toBe(false);
  });

  it('parses required_tools and tags', () => {
    const raw = `---
name: Citation Formatter
description: Format citations
tags: [research, citation]
required_tools: [read_file, search_web]
---
# Body content`;
    const result = parseAgentSkills(raw, '/skills/citation.md', 'ethos', 'citation', MTIME);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Citation Formatter');
    expect(result?.tags).toEqual(['research', 'citation']);
    expect(result?.required_tools).toEqual(['read_file', 'search_web']);
    expect(result?.body).toBe('# Body content');
    expect(result?.dialect).toBe('agentskills');
  });

  it('falls back to path name when frontmatter has no name', () => {
    const raw = `---
tags: [code]
---
Body`;
    const result = parseAgentSkills(raw, '/skills/my-tool.md', 'ethos', 'my-tool', MTIME);
    expect(result?.name).toBe('my-tool');
  });

  it('returns undefined for tags when list is empty', () => {
    const raw = `---
tags: []
---
Body`;
    const result = parseAgentSkills(raw, '/p.md', 's', 'n', MTIME);
    expect(result?.tags).toBeUndefined();
  });
});

describe('openclaw dialect', () => {
  it('canParse when metadata.openclaw block present', () => {
    expect(clawCan({ metadata: { openclaw: { requires: {} } } })).toBe(true);
  });

  it('canParse when metadata.clawdbot present', () => {
    expect(clawCan({ metadata: { clawdbot: {} } })).toBe(true);
  });

  it('rejects when metadata is absent', () => {
    expect(clawCan({})).toBe(false);
  });

  it('rejects when metadata has no known key', () => {
    expect(clawCan({ metadata: { other: {} } })).toBe(false);
  });

  it('parses name and tags', () => {
    const raw = `---
name: Bash Helper
tags: [shell, terminal]
metadata:
  openclaw:
    requires:
      bins: [bash]
---
Do shell things`;
    const result = parseOpenClaw(raw, '/skills/bash/SKILL.md', 'openclaw', 'bash', MTIME);
    expect(result?.name).toBe('Bash Helper');
    expect(result?.tags).toEqual(['shell', 'terminal']);
    expect(result?.dialect).toBe('openclaw');
  });
});

describe('hermes dialect', () => {
  it('canParse when agent field present', () => {
    expect(hermesCan({ agent: 'spotify' })).toBe(true);
  });

  it('canParse when category field present', () => {
    expect(hermesCan({ category: 'media' })).toBe(true);
  });

  it('rejects empty frontmatter', () => {
    expect(hermesCan({})).toBe(false);
  });

  it('maps category to tags when no tags field', () => {
    const raw = `---
name: Spotify
category: media
---
Controls Spotify`;
    const result = parseHermes(raw, '/skills/spotify.md', 'hermes', 'spotify', MTIME);
    expect(result?.tags).toEqual(['media']);
    expect(result?.dialect).toBe('hermes');
  });

  it('prefers explicit tags over category', () => {
    const raw = `---
category: media
tags: [music, playback]
---
Body`;
    const result = parseHermes(raw, '/p.md', 'h', 'n', MTIME);
    expect(result?.tags).toEqual(['music', 'playback']);
  });
});

// ---------------------------------------------------------------------------
// Lane A — `ethos.renders` renderer declarations
// ---------------------------------------------------------------------------

const SKILLS_DIR = '/home/ethos/skills';

/** Frontmatter with an arbitrary `ethos.renders` YAML value. */
function withRenders(rendersYaml: string): string {
  return `---
name: Charts
description: Render interactive charts
ethos:
  category: document
  renders: ${rendersYaml}
---
Emit an echarts fence.`;
}

describe('ethos.renders', () => {
  it('scans a declaring skill to renders === [echarts@1] (agentskills)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(SKILLS_DIR);
    await storage.write(`${SKILLS_DIR}/charts.md`, withRenders("['echarts@1']"));

    const pool = await new UniversalScanner({
      storage,
      sources: [{ label: 'ethos', dir: SKILLS_DIR }],
    }).scan();

    const skill = pool.get('ethos/charts');
    expect(skill?.dialect).toBe('agentskills');
    expect(skill?.renders).toEqual(['echarts@1']);
  });

  it('yields the same shape across dialects', () => {
    const agent = parseAgentSkills(withRenders("['echarts@1']"), '/p.md', 's', 'n', MTIME);
    const hermes = parseHermes(
      `---
name: Charts
category: document
ethos:
  renders: ['echarts@1']
---
Body`,
      '/p.md',
      's',
      'n',
      MTIME,
    );
    const claw = parseOpenClaw(
      `---
name: Charts
metadata:
  openclaw:
    requires: {}
ethos:
  renders: ['echarts@1']
---
Body`,
      '/p.md',
      's',
      'n',
      MTIME,
    );

    expect(agent?.renders).toEqual(['echarts@1']);
    expect(hermes?.renders).toEqual(['echarts@1']);
    expect(claw?.renders).toEqual(['echarts@1']);
  });

  it('accepts multi-digit and hyphenated renderer names', () => {
    const result = parseAgentSkills(
      withRenders("['vega-lite@12', 'echarts@1']"),
      '/p.md',
      's',
      'n',
      MTIME,
    );
    expect(result?.renders).toEqual(['vega-lite@12', 'echarts@1']);
  });

  it.each([
    ['no version', "['echarts']"],
    ['empty version', "['echarts@']"],
    ['semver version', "['echarts@1.2']"],
    ['non-string entries', '[1, true, null, {a: 1}]'],
    ['uppercase name', "['ECharts@1']"],
    ['leading digit', "['1echarts@1']"],
    ['not a list', 'echarts@1'],
  ])('drops malformed entries — %s → undefined', (_label, yaml) => {
    const result = parseAgentSkills(withRenders(yaml), '/p.md', 's', 'n', MTIME);
    expect(result?.renders).toBeUndefined();
  });

  it('keeps only the valid entries when mixed', () => {
    const result = parseAgentSkills(
      withRenders("['echarts', 'echarts@1', 'echarts@1.2', 'mermaid@2', 3]"),
      '/p.md',
      's',
      'n',
      MTIME,
    );
    expect(result?.renders).toEqual(['echarts@1', 'mermaid@2']);
  });

  it('is undefined when the skill declares no renders', () => {
    const noEthos = parseAgentSkills(
      `---
name: Plain
description: No ethos block
---
Body`,
      '/p.md',
      's',
      'n',
      MTIME,
    );
    const emptyEthos = parseAgentSkills(
      `---
name: Plain
description: Ethos block without renders
ethos:
  category: document
---
Body`,
      '/p.md',
      's',
      'n',
      MTIME,
    );

    expect(noEthos?.renders).toBeUndefined();
    expect(emptyEthos?.renders).toBeUndefined();
  });

  it('is undefined for an empty renders list', () => {
    const result = parseAgentSkills(withRenders('[]'), '/p.md', 's', 'n', MTIME);
    expect(result?.renders).toBeUndefined();
  });
});

describe('UniversalScanner — malformed frontmatter', () => {
  const DIR = '/skills';

  const BROKEN = [
    '---',
    'name: stock-add',
    'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
    '---',
    '',
    'Body.',
  ].join('\n');

  it('skips a skill whose YAML frontmatter cannot be parsed instead of throwing', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(DIR);
    await storage.write(`${DIR}/broken.md`, BROKEN);

    const skipped: Array<{ name: string; reason: string }> = [];
    const pool = await new UniversalScanner({
      storage,
      sources: [{ label: 'ethos', dir: DIR }],
      onSkip: (name, reason) => skipped.push({ name, reason }),
    }).scan();

    expect(pool.get('ethos/broken')).toBeUndefined();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe('ethos/broken');
    expect(skipped[0]?.reason).toContain('invalid frontmatter');
  });

  it('still loads the healthy skills alongside a broken one', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(DIR);
    await storage.write(`${DIR}/broken.md`, BROKEN);
    await storage.write(`${DIR}/good.md`, '---\nname: Good\ndescription: fine\n---\n\nBody.');

    const pool = await new UniversalScanner({
      storage,
      sources: [{ label: 'ethos', dir: DIR }],
    }).scan();

    expect(pool.get('ethos/good')?.name).toBe('Good');
    expect(pool.get('ethos/broken')).toBeUndefined();
  });
});
