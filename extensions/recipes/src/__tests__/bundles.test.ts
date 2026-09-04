// The bundle table test (plan §7). Every shipped bundle must parse, and the two
// cross-field invariants must hold — an authoring typo fails at `pnpm test`
// rather than at install time on someone's machine.

import { describe, expect, it } from 'vitest';
import { morningBriefing, RECIPES } from '../data';
import { RecipeBundleSchema } from '../schema';

describe('RECIPES', () => {
  it('ships at least one bundle', () => {
    expect(RECIPES.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const recipe of RECIPES) {
    describe(recipe.id, () => {
      it('parses against the schema', () => {
        const result = RecipeBundleSchema.safeParse(recipe);
        expect(result.error?.issues ?? []).toEqual([]);
        expect(result.success).toBe(true);
      });

      it('personality.mcpServers equals requires.mcpServers[].name', () => {
        expect([...(recipe.personality.mcpServers ?? [])].sort()).toEqual(
          recipe.requires.mcpServers.map((s) => s.name).sort(),
        );
      });

      it('personality.plugins equals requires.plugins[].id', () => {
        expect([...(recipe.personality.plugins ?? [])].sort()).toEqual(
          recipe.requires.plugins.map((p) => p.id).sort(),
        );
      });
    });
  }
});

describe('RecipeBundleSchema', () => {
  const base = RECIPES[0];
  if (!base) throw new Error('RECIPES is empty');

  it('rejects a personality.mcpServers that drifts from requires.mcpServers', () => {
    const drifted = {
      ...base,
      personality: { ...base.personality, mcpServers: ['gcal-typo'] },
    };
    const result = RecipeBundleSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('requires.mcpServers[].name');
  });

  it('rejects a personality.plugins that drifts from requires.plugins', () => {
    const drifted = { ...base, personality: { ...base.personality, plugins: ['ghost'] } };
    const result = RecipeBundleSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('requires.plugins[].id');
  });

  it("treats an mcpServer with no `optional` flag as required — absence keeps today's meaning", () => {
    const server = base.requires.mcpServers[0];
    if (!server) throw new Error('the base bundle declares no MCP server');
    const { optional: _dropped, ...withoutFlag } = server;
    const parsed = RecipeBundleSchema.safeParse({
      ...base,
      requires: { ...base.requires, mcpServers: [withoutFlag] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.requires.mcpServers[0]?.optional).toBeUndefined();
  });

  it('rejects a placeholder naming an input the bundle never declares', () => {
    const drifted = {
      ...base,
      personality: { ...base.personality, soulMd: 'I live in {{input.nowhere}}.' },
    };
    const result = RecipeBundleSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('nowhere');
  });

  it('rejects a channel-delivering job with no required chatTarget input', () => {
    const drifted = {
      ...base,
      requires: {
        ...base.requires,
        inputs: base.requires.inputs.filter((i) => i.kind !== 'chatTarget'),
      },
      personality: { ...base.personality, soulMd: 'No placeholders here.' },
      cronJobs: base.cronJobs.map((j) => ({ ...j, schedule: '0 6 * * *', deliverTo: 'channel' })),
    };
    const result = RecipeBundleSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('chatTarget');
  });
});

describe('authoring invariants', () => {
  it('refuses a credential requirement for a tool the recipe does not grant', () => {
    // An unclearable row is the failure mode this whole flow exists to avoid:
    // nothing in the recipe would consume the key the user was asked for.
    const bad = {
      ...morningBriefing,
      requires: {
        ...morningBriefing.requires,
        secrets: [{ toolName: 'x_search', label: 'X key', why: 'searches X' }],
      },
    };
    const result = RecipeBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('not in requires.tools');
  });
});
