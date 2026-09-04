// Templater tests (plan §7): substitution into soul / prompt / schedule /
// fsReach, and the hard error on an unresolved placeholder.

import { describe, expect, it } from 'vitest';
import { morningBriefing, obsidianSecondBrain } from '../data';
import { projectBundle, type RecipeBundle } from '../schema';
import {
  appendRecipeSoulSection,
  hasRecipeSoulSection,
  placeholderKeys,
  RecipeTemplateError,
  type ResolvedRecipe,
  recipeSoulMarkers,
  renderRecipe,
  renderTemplate,
  renderTemplatePreview,
  resolveInputs,
  unresolvedPlaceholders,
} from '../template';

const FILLED = {
  city: 'Bengaluru',
  units: 'metric',
  topics: 'AI infra, F1',
  briefingTime: '20 6 * * *',
  chatTarget: '12345',
};

/** The create variant of a resolved personality — what every bundle rendered below is. */
function created(resolved: ResolvedRecipe) {
  const p = resolved.personality;
  if (p.mode !== 'create') throw new Error('expected a create-mode personality');
  return p;
}

describe('placeholderKeys', () => {
  it('finds each key once, in first-seen order', () => {
    expect(placeholderKeys('{{input.b}} then {{input.a}} then {{input.b}}')).toEqual(['b', 'a']);
  });

  it('ignores anything that is not the one supported form', () => {
    expect(placeholderKeys('{{argument}} {{ input.a }} {{inputs.a}}')).toEqual([]);
  });
});

describe('renderTemplate', () => {
  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{input.city}} and {{input.city}}', FILLED, 'f')).toBe(
      'Bengaluru and Bengaluru',
    );
  });

  it('throws on a missing value rather than rendering an empty string', () => {
    expect(() => renderTemplate('I live in {{input.city}}.', {}, 'personality.soulMd')).toThrow(
      RecipeTemplateError,
    );
    try {
      renderTemplate('I live in {{input.city}}.', {}, 'personality.soulMd');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RecipeTemplateError);
      const templateError = err as RecipeTemplateError;
      expect(templateError.field).toBe('personality.soulMd');
      expect(templateError.keys).toEqual(['city']);
      expect(templateError.message).toContain('{{input.city}}');
    }
  });

  it('treats a blank value as unresolved', () => {
    expect(unresolvedPlaceholders('{{input.city}}', { city: '   ' })).toEqual(['city']);
    expect(() => renderTemplate('{{input.city}}', { city: '   ' }, 'f')).toThrow(
      RecipeTemplateError,
    );
  });
});

describe('renderTemplatePreview', () => {
  it('leaves an unresolved placeholder standing instead of blanking it', () => {
    expect(renderTemplatePreview('{{input.city}} / {{input.units}}', { units: 'metric' })).toBe(
      '{{input.city}} / metric',
    );
  });
});

describe('resolveInputs', () => {
  it('applies declared defaults and reports what is still required', () => {
    const { values, missing } = resolveInputs(morningBriefing, { city: 'Berlin' });
    expect(values.city).toBe('Berlin');
    expect(values.units).toBe('metric');
    expect(values.briefingTime).toBe('20 6 * * *');
    expect(missing.map((i) => i.key)).toEqual(['topics', 'chatTarget']);
  });

  it('lets a supplied value win over the default', () => {
    const { values } = resolveInputs(morningBriefing, { units: 'imperial' });
    expect(values.units).toBe('imperial');
  });
});

describe('renderRecipe', () => {
  it('resolves the soul, the schedule and the prompt', () => {
    const resolved = renderRecipe(morningBriefing, FILLED);
    expect(created(resolved).soulMd).toContain('city: Bengaluru');
    expect(created(resolved).soulMd).not.toContain('{{input.');
    expect(resolved.cronJobs[0]?.schedule).toBe('20 6 * * *');
    expect(resolved.cronJobs[0]?.prompt).toContain('morning briefing');
  });

  it('resolves fs_reach paths', () => {
    const bundle: RecipeBundle = {
      ...morningBriefing,
      personality: {
        ...morningBriefing.personality,
        fsReach: {
          read: ['{{input.city}}/notes'],
          write: ['{{input.city}}/out'],
          workdir: ['{{input.city}}'],
        },
      },
    };
    const resolved = renderRecipe(bundle, FILLED);
    expect(created(resolved).fsReach).toEqual({
      read: ['Bengaluru/notes'],
      write: ['Bengaluru/out'],
      workdir: ['Bengaluru'],
    });
  });

  it('refuses to render a bundle whose required input is unfilled', () => {
    expect(() => renderRecipe(morningBriefing, { ...FILLED, city: '' })).toThrow(
      RecipeTemplateError,
    );
  });
});

// ---------------------------------------------------------------------------
// D15 — the network policy a bundle installs with
// ---------------------------------------------------------------------------

describe('renderRecipe — network policy', () => {
  it("gives an undeclared bundle allow: ['*']", () => {
    // Absent is not neutral. `web_extract` declares `allowedHosts: ['*']`,
    // which defers to the PERSONALITY's policy, and an absent one resolves to
    // an empty host set — every fetch denied with HOST_NOT_ALLOWED.
    expect(morningBriefing.personality.safety).toBeUndefined();
    const resolved = renderRecipe(morningBriefing, FILLED);
    expect(created(resolved).safety).toEqual({ network: { allow: ['*'] } });
  });

  it('leaves a bundle that declares its own alone', () => {
    const locked: RecipeBundle = {
      ...morningBriefing,
      personality: {
        ...morningBriefing.personality,
        safety: { network: { allow: ['api.open-meteo.com'], deny: ['example.com'] } },
      },
    };
    const resolved = renderRecipe(locked, FILLED);
    expect(created(resolved).safety).toEqual({
      network: { allow: ['api.open-meteo.com'], deny: ['example.com'] },
    });
  });

  it('does not share one array between two installs', () => {
    const first = renderRecipe(morningBriefing, FILLED);
    created(first).safety?.network.allow?.push('mutated.example');
    const second = renderRecipe(morningBriefing, FILLED);
    expect(created(second).safety).toEqual({ network: { allow: ['*'] } });
  });
});

// ---------------------------------------------------------------------------
// Attach mode — the section, the reach, and the markers
// ---------------------------------------------------------------------------

describe('renderRecipe — attach mode', () => {
  const VAULT = { vaultPath: '/Users/you/Vault/', consolidationTime: '30 23 * * *' };
  const attach = projectBundle(obsidianSecondBrain, 'attach');

  it('resolves the soul section and both reach lists, and nothing else', () => {
    const resolved = renderRecipe(attach, VAULT);
    const p = resolved.personality;
    if (p.mode !== 'attach') throw new Error('expected an attach-mode personality');
    expect(p.soulSection).toContain('/Users/you/Vault/');
    expect(p.soulSection).not.toContain('{{input.');
    expect(p.fsReach).toEqual({ read: ['/Users/you/Vault/'], write: ['/Users/you/Vault/'] });
    // No network policy is ever minted for an attach — that is the target's.
    expect('safety' in p).toBe(false);
  });

  it('refuses an unfilled placeholder in the section', () => {
    expect(() => renderRecipe(attach, { consolidationTime: '30 23 * * *' })).toThrow(
      RecipeTemplateError,
    );
  });

  it('renders BOTH halves of a `both` bundle when it is not projected', () => {
    const resolved = renderRecipe(obsidianSecondBrain, VAULT);
    const p = resolved.personality;
    if (p.mode !== 'both') throw new Error('expected a both-mode personality');
    expect(p.soulMd).toContain('/Users/you/Vault/');
    expect(p.fsReach?.workdir).toBe('/Users/you/Vault/');
    expect(p.attach.soulSection).toContain('/Users/you/Vault/');
    expect(p.attach.fsReach).toEqual({ read: ['/Users/you/Vault/'], write: ['/Users/you/Vault/'] });
  });
});

describe('the marked SOUL section', () => {
  it('appends between the markers and is detectable afterwards', () => {
    const soul = 'I am Writer.\n';
    const next = appendRecipeSoulSection(soul, 'obsidian-second-brain', '## Vault\n\nRules.\n');
    const { start, end } = recipeSoulMarkers('obsidian-second-brain');
    expect(next).toBe(`I am Writer.\n\n${start}\n## Vault\n\nRules.\n${end}\n`);
    expect(hasRecipeSoulSection(soul, 'obsidian-second-brain')).toBe(false);
    expect(hasRecipeSoulSection(next, 'obsidian-second-brain')).toBe(true);
    // A different recipe's marker is a different section.
    expect(hasRecipeSoulSection(next, 'link-archiver')).toBe(false);
  });

  it('does not double the newline when the SOUL already ends with one', () => {
    const next = appendRecipeSoulSection('I am Writer.', 'r', 'Section');
    expect(next.startsWith('I am Writer.\n\n<!-- recipe:r:start -->')).toBe(true);
  });
});
