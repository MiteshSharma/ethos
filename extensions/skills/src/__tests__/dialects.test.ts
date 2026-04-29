import { describe, expect, it } from 'vitest';
import { canParse as agentCan, parseAgentSkills } from '../dialects/agentskills';
import { canParse as hermesCan, parseHermes } from '../dialects/hermes';
import { canParse as clawCan, parseOpenClaw } from '../dialects/openclaw';

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
