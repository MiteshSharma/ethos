// The toolset-name test (plan §7) — "the check that rots fastest".
//
// A renamed or deleted tool silently breaks every recipe that used it, and
// nothing else in the repo would notice: the personality would install fine and
// simply never be able to do the thing the recipe promised.
//
// A registry cannot be built here — `@ethosagent/recipes` depends on
// `@ethosagent/types` only, and composing the real registry is wiring's job —
// so the known-name set is read from the tool sources themselves. That is a
// deliberately loose approximation in ONE direction: an unrelated `name:` field
// can add a name that is not a tool (making the check weaker), but a tool that
// exists is always found (so the check never fails a valid recipe). Tools that
// arrive from a plugin are not visible here; a recipe requiring one is covered
// by preflight's PLUGIN_MISSING row at install time instead.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECIPES } from '../data';
import { unknownToolNames } from '../preflight';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const EXTENSIONS = join(REPO_ROOT, 'extensions');
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);
// MCP tools are gated by `personality.mcp_servers`, not by `toolset` (the same
// exclusion `tools.catalog` makes), and presets.ts declares SERVER names.
const SKIP_PACKAGES = new Set(['tools-mcp']);
const TOOL_NAME = /\bname:\s*'([a-z][a-z0-9_]*)'/g;

function collectToolNames(dir: string, into: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectToolNames(join(dir, entry.name), into);
    } else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(join(dir, entry.name), 'utf-8');
      for (const match of source.matchAll(TOOL_NAME)) {
        const name = match[1];
        if (name) into.add(name);
      }
    }
  }
}

function knownToolNames(): Set<string> {
  const names = new Set<string>();
  for (const pkg of readdirSync(EXTENSIONS, { withFileTypes: true })) {
    if (!pkg.isDirectory() || !pkg.name.startsWith('tools-')) continue;
    if (SKIP_PACKAGES.has(pkg.name)) continue;
    collectToolNames(join(EXTENSIONS, pkg.name, 'src'), names);
  }
  return names;
}

describe('recipe toolsets', () => {
  const known = knownToolNames();

  it('finds the tool sources', () => {
    // A guard on the scan itself: an empty set would make every assertion below
    // pass for the wrong reason.
    expect(known.size).toBeGreaterThan(50);
  });

  for (const recipe of RECIPES) {
    it(`${recipe.id} names only tools that exist`, () => {
      const unknown = unknownToolNames(recipe, known);
      expect(
        unknown,
        unknown.length === 0
          ? ''
          : `Recipe '${recipe.id}' names ${unknown.length} tool(s) that no extensions/tools-* package declares: ` +
              `${unknown.join(', ')}.\n` +
              'A tool was probably renamed or removed. Fix it in ' +
              `extensions/recipes/src/data/${recipe.id}.ts — update both personality.toolset and ` +
              'requires.tools to the new name, or drop the capability from the recipe and from its ' +
              'SOUL text. Do NOT add the name here.',
      ).toEqual([]);
    });
  }
});
