// The bundle table test (plan §7). Every shipped bundle must parse, and the two
// cross-field invariants must hold — an authoring typo fails at `pnpm test`
// rather than at install time on someone's machine.

import { describe, expect, it } from 'vitest';
import { morningBriefing, obsidianSecondBrain, RECIPES } from '../data';
import {
  projectBundle,
  projectPersonality,
  RecipeBundleSchema,
  resolveInstallMode,
} from '../schema';

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

      it('names the same tools in every view it offers', () => {
        // `unknownToolNames` and preflight both read the projected toolset, so
        // a `both` bundle whose halves disagreed would pass one and fail the
        // other at install time.
        const views = recipe.personality.mode === 'both' ? (['create', 'attach'] as const) : [];
        for (const mode of views) {
          expect(projectPersonality(recipe, mode).toolset).toEqual(recipe.requires.tools);
        }
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

describe('RecipeBundleSchema — attach and both modes', () => {
  /** The shipped `both` bundle as a pure attach bundle. */
  const attachOnly = projectBundle(obsidianSecondBrain, 'attach');

  it('accepts the shipped both bundle, and each of its projections', () => {
    for (const bundle of [
      obsidianSecondBrain,
      attachOnly,
      projectBundle(obsidianSecondBrain, 'create'),
    ]) {
      const result = RecipeBundleSchema.safeParse(bundle);
      expect(result.error?.issues ?? []).toEqual([]);
    }
  });

  it('rejects create-only fields on an attach personality', () => {
    // Identity, routing and network policy belong to the target. A bundle that
    // tries to set them is refused, not silently stripped.
    for (const extra of [
      { id: 'archivist' },
      { name: 'Archivist' },
      { model: 'claude-sonnet-4-6' },
      { safety: { network: { allow: [] } } },
      { fsReach: { read: ['/x/'], workdir: '/x/' } },
    ]) {
      const bad = { ...attachOnly, personality: { ...attachOnly.personality, ...extra } };
      expect(RecipeBundleSchema.safeParse(bad).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('rejects the same fields inside a both bundle’s attach half', () => {
    const p = obsidianSecondBrain.personality;
    const bad = {
      ...obsidianSecondBrain,
      personality: { ...p, attach: { ...p.attach, safety: { network: { allow: [] } } } },
    };
    expect(RecipeBundleSchema.safeParse(bad).success).toBe(false);
  });

  it('requires every {{input.*}} in soulSection to be declared — in both shapes', () => {
    const p = obsidianSecondBrain.personality;
    for (const bad of [
      {
        ...attachOnly,
        personality: { ...attachOnly.personality, soulSection: '{{input.nowhere}}' },
      },
      {
        ...obsidianSecondBrain,
        personality: { ...p, attach: { ...p.attach, soulSection: 'Vault: {{input.nowhere}}' } },
      },
    ]) {
      const result = RecipeBundleSchema.safeParse(bad);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('nowhere');
    }
  });

  it('scans attach fsReach for undeclared inputs too — in both shapes', () => {
    const p = obsidianSecondBrain.personality;
    for (const bad of [
      {
        ...attachOnly,
        personality: { ...attachOnly.personality, fsReach: { read: ['{{input.ghost}}'] } },
      },
      {
        ...obsidianSecondBrain,
        personality: { ...p, attach: { ...p.attach, fsReach: { read: ['{{input.ghost}}'] } } },
      },
    ]) {
      const result = RecipeBundleSchema.safeParse(bad);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('ghost');
    }
  });

  it('holds attach mcpServers to the same set-equality rule — in both shapes', () => {
    const p = obsidianSecondBrain.personality;
    const bad = {
      ...obsidianSecondBrain,
      personality: { ...p, attach: { ...p.attach, mcpServers: ['obsidian-rest'] } },
    };
    const result = RecipeBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('personality.attach.mcpServers');
  });
});

describe('resolveInstallMode / projectPersonality', () => {
  it('a single-mode bundle is its mode, whatever is requested', () => {
    expect(resolveInstallMode(morningBriefing)).toBe('create');
    expect(resolveInstallMode(morningBriefing, 'attach')).toBe('create');
    const attachOnly = projectBundle(obsidianSecondBrain, 'attach');
    expect(resolveInstallMode(attachOnly, 'create')).toBe('attach');
  });

  it('a both bundle takes the request and defaults to create', () => {
    expect(resolveInstallMode(obsidianSecondBrain)).toBe('create');
    expect(resolveInstallMode(obsidianSecondBrain, 'attach')).toBe('attach');
  });

  it('projects a both bundle to either view, and nothing leaks across', () => {
    const create = projectPersonality(obsidianSecondBrain, 'create');
    expect(create.mode).toBe('create');
    expect(create.id).toBe('obsidian-archivist');
    expect('attach' in create).toBe(false);
    const attach = projectPersonality(obsidianSecondBrain, 'attach');
    expect(attach.mode).toBe('attach');
    expect(attach).toEqual({ mode: 'attach', ...obsidianSecondBrain.personality.attach });
  });

  it('returns a single-mode personality as itself and refuses the other view', () => {
    expect(projectPersonality(morningBriefing, 'create')).toBe(morningBriefing.personality);
    expect(() => projectPersonality(morningBriefing, 'attach')).toThrow(/create-only/);
  });
});
