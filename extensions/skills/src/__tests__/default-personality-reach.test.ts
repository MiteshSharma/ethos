// A skill's `ethos.default_personalities` names the personalities it is meant
// to serve. `ingest-filter.ts` independently excludes any skill whose
// `required_tools` fall outside a personality's effective tool reach. Nothing
// checked that the two agreed — so a skill could name exactly one personality
// and be structurally incapable of loading on it, silently, forever.
//
// That is what happened to `research/grounded-citations`: it required
// `terminal`, targeted `researcher`, and `researcher` is deliberately
// read-only. This test is the gate for that whole class.
//
// Toolsets are read straight from the shipped personality data. The file is a
// flat YAML list by contract ("toolset.yaml ← flat list of allowed tool
// names"), so it is read here directly rather than dragging an
// extension-to-extension dependency into @ethosagent/skills for a test.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { bundledSkillsSource } from '../bundled';

const SKILLS_DIR = bundledSkillsSource().dir;
const PERSONALITY_DATA_DIR = join(import.meta.dirname, '..', '..', '..', 'personalities', 'data');

/**
 * Personality ids that appear in `default_personalities` but ship no built-in
 * toolset — they live under `personalities/data/archived/`. Naming an archived
 * personality is a separate (documentation) problem from naming a live one it
 * cannot serve, so those pairs are not tool-checked. Listing them explicitly
 * means a *typo'd* id still fails this test.
 */
const ARCHIVED_PERSONALITY_IDS = ['coordinator', 'operator'];

/**
 * Pre-existing `skill -> personality` pairs where the personality's toolset
 * does not satisfy the skill's `required_tools`, so the skill can never load
 * on a personality that names it.
 *
 * This is a quarantine list, not an allowlist: every entry is a live bug of
 * the same class as the `grounded-citations` one, left untouched because
 * fixing them means either widening a deliberately narrow toolset or
 * redesigning each skill's degradation story — one decision per skill.
 *
 * The assertion below is exact equality. Fix one, delete its line. Introduce a
 * new one, and the test names it.
 */
const KNOWN_UNREACHABLE: Record<string, string[]> = {
  'autonomous-ai-agents/claude-code -> engineer': ['process_start', 'process_logs', 'process_stop'],
  'autonomous-ai-agents/codex -> engineer': ['process_start', 'process_logs', 'process_stop'],
  'autonomous-ai-agents/opencode -> engineer': ['process_start', 'process_logs', 'process_stop'],
  'framework/a2a-communicate -> engineer': ['a2a_send'],
  'framework/a2a-handle-inbound -> engineer': ['a2a_send'],
  'framework/codebase-inspection -> reviewer': ['terminal'],
  'github/github-auth -> reviewer': ['terminal'],
  'github/github-code-review -> reviewer': ['terminal'],
  'github/github-issues -> reviewer': ['terminal'],
  'research/arxiv -> researcher': ['terminal'],
  'research/research-paper-writing -> researcher': ['terminal'],
  'software-development/code-review -> reviewer': ['terminal'],
  'software-development/plan -> reviewer': ['write_file'],
  'software-development/systematic-debugging -> reviewer': ['terminal'],
  'software-development/tdd -> reviewer': ['write_file', 'patch_file', 'terminal'],
};

/** Parse a flat `- name` YAML list, ignoring comments and blank lines. */
function parseToolsetYaml(src: string): Set<string> {
  const tools = new Set<string>();
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    tools.add(line.slice(2).trim());
  }
  return tools;
}

/** id → toolset for every built-in personality (archived ones excluded). */
function loadBuiltinToolsets(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of readdirSync(PERSONALITY_DATA_DIR)) {
    const toolsetPath = join(PERSONALITY_DATA_DIR, id, 'toolset.yaml');
    if (!statSync(toolsetPath, { throwIfNoEntry: false })?.isFile()) continue;
    out.set(id, parseToolsetYaml(readFileSync(toolsetPath, 'utf8')));
  }
  return out;
}

interface SkillDecl {
  /** `<category>/<name>`, matching the bundled skill id. */
  id: string;
  requiredTools: string[];
  defaultPersonalities: string[];
}

/** Every `skills/<category>/<name>/SKILL.md` that declares default personalities. */
function loadSkillDecls(): SkillDecl[] {
  const decls: SkillDecl[] = [];
  for (const category of readdirSync(SKILLS_DIR)) {
    const categoryDir = join(SKILLS_DIR, category);
    if (!statSync(categoryDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const name of readdirSync(categoryDir)) {
      const skillMd = join(categoryDir, name, 'SKILL.md');
      if (!statSync(skillMd, { throwIfNoEntry: false })?.isFile()) continue;
      const { data } = matter(readFileSync(skillMd, 'utf8'));
      const ethos = (data.ethos ?? {}) as {
        default_personalities?: unknown;
        permissions?: { tools_required?: unknown };
      };
      const defaults = ethos.default_personalities;
      if (!Array.isArray(defaults) || defaults.length === 0) continue;
      // Mirrors `capabilityCheck` in ingest-filter.ts, which merges both.
      const required = [
        ...(Array.isArray(data.required_tools) ? (data.required_tools as string[]) : []),
        ...(Array.isArray(ethos.permissions?.tools_required)
          ? (ethos.permissions.tools_required as string[])
          : []),
      ];
      decls.push({
        id: `${category}/${name}`,
        requiredTools: required,
        defaultPersonalities: defaults as string[],
      });
    }
  }
  return decls;
}

/** `skill -> personality` → the required tools that personality cannot reach. */
function computeUnreachable(): Record<string, string[]> {
  const toolsets = loadBuiltinToolsets();
  const found: Record<string, string[]> = {};
  for (const skill of loadSkillDecls()) {
    for (const personalityId of skill.defaultPersonalities) {
      const toolset = toolsets.get(personalityId);
      if (!toolset) continue; // not a built-in — covered by the archived-id test
      const missing = skill.requiredTools.filter((t) => !toolset.has(t));
      if (missing.length > 0) found[`${skill.id} -> ${personalityId}`] = missing;
    }
  }
  return found;
}

describe('skills: default_personalities must be able to satisfy required_tools', () => {
  it('finds at least one skill and one personality to check', () => {
    expect(loadSkillDecls().length).toBeGreaterThan(0);
    expect(loadBuiltinToolsets().size).toBeGreaterThan(0);
  });

  it('grounded-citations loads on every personality it targets', () => {
    const unreachable = computeUnreachable();
    const offenders = Object.keys(unreachable).filter((k) =>
      k.startsWith('research/grounded-citations ->'),
    );
    expect(offenders, `grounded-citations unreachable on: ${offenders.join('; ')}`).toEqual([]);
  });

  it('no skill/personality pair is unreachable beyond the quarantined set', () => {
    // Exact equality both ways: a new mismatch fails, and a fixed one that was
    // left in the list fails too, so the quarantine cannot rot.
    expect(computeUnreachable()).toEqual(KNOWN_UNREACHABLE);
  });

  it('every named personality is a built-in or a documented archived id', () => {
    const builtin = loadBuiltinToolsets();
    const unresolved = new Set<string>();
    for (const skill of loadSkillDecls()) {
      for (const id of skill.defaultPersonalities) {
        if (!builtin.has(id) && !ARCHIVED_PERSONALITY_IDS.includes(id)) {
          unresolved.add(`${skill.id} -> ${id}`);
        }
      }
    }
    expect([...unresolved]).toEqual([]);
  });
});
