// Per-bundle assertions for the shipped catalog — the facts each recipe's
// header comment claims, checked rather than trusted. The table test
// (bundles.test.ts) proves every bundle parses; this proves the authored
// deviations actually landed.

import { describe, expect, it } from 'vitest';
import { linkArchiver, obsidianSecondBrain, RECIPES, webWatchdog } from '../data';
import { projectBundle } from '../schema';
import { renderRecipe } from '../template';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
const SELF_DIR = '${ETHOS_HOME}/personalities/${self}/';
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
const SKILLS_DIR = '${ETHOS_HOME}/skills/';

describe('RECIPES', () => {
  it('ships the three usecase bundles', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(ids).toContain('obsidian-second-brain');
    expect(ids).toContain('link-archiver');
    expect(ids).toContain('web-watchdog');
  });
});

describe('obsidian-second-brain', () => {
  const VAULT = { vaultPath: '/Users/you/Vault/', consolidationTime: '30 23 * * *' };

  it('is offered in both modes, with one toolset feeding both', () => {
    expect(obsidianSecondBrain.personality.mode).toBe('both');
    expect(obsidianSecondBrain.personality.toolset).toEqual(obsidianSecondBrain.requires.tools);
    expect(obsidianSecondBrain.personality.attach.toolset).toEqual(
      obsidianSecondBrain.requires.tools,
    );
    // Cross-session reading through the session tools is not something a
    // scheduled run can do; the memory files are the honest bridge.
    expect(obsidianSecondBrain.requires.tools).not.toContain('session_search');
    expect(obsidianSecondBrain.requires.tools).not.toContain('session_list_by_date');
    expect(obsidianSecondBrain.requires.tools).toContain('memory_read');
  });

  it('create view: the vault becomes the workdir, the self entries stay, and it is offline', () => {
    const resolved = renderRecipe(projectBundle(obsidianSecondBrain, 'create'), VAULT);
    const p = resolved.personality;
    if (p.mode !== 'create') throw new Error('expected a create-mode personality');
    expect(p.id).toBe('obsidian-archivist');
    expect(p.fsReach).toEqual({
      read: [SELF_DIR, SKILLS_DIR],
      write: [SELF_DIR],
      workdir: '/Users/you/Vault/',
    });
    expect(p.soulMd.startsWith('I am Archivist.')).toBe(true);
    expect(p.soulMd).toContain('/Users/you/Vault/');
    expect(p.soulMd).not.toContain('{{input.');
    // An explicit empty allow list, not the D15 default — see the header.
    expect(p.safety).toEqual({ network: { allow: [] } });
  });

  it('attach view: only the vault is added to reach, and the same rules ride in the section', () => {
    const resolved = renderRecipe(projectBundle(obsidianSecondBrain, 'attach'), VAULT);
    const p = resolved.personality;
    if (p.mode !== 'attach') throw new Error('expected an attach-mode personality');
    // Only the vault: the target keeps its own reach, and the installer appends.
    expect(p.fsReach).toEqual({ read: ['/Users/you/Vault/'], write: ['/Users/you/Vault/'] });
    expect(p.soulSection.startsWith('## Your Obsidian vault')).toBe(true);
    expect(p.soulSection).toContain('/Users/you/Vault/');
    expect(p.soulSection).not.toContain('{{input.');
    expect(p.soulSection).toContain('## Distilled by <your name>');
    // No network policy of its own — that is the target's.
    expect('safety' in p).toBe(false);
  });

  it('composes the create SOUL and the attach section from ONE rules text', () => {
    const { soulMd, attach } = obsidianSecondBrain.personality;
    const rules = attach.soulSection.replace('## Your Obsidian vault\n\n', '');
    expect(soulMd.endsWith(rules)).toBe(true);
  });

  it('distils from the memory files nightly, in-app, skipping missed runs', () => {
    const job = obsidianSecondBrain.cronJobs[0];
    expect(job?.name).toBe('vault-consolidation');
    expect(job?.prompt).toContain('memory_read');
    expect(job?.deliverTo).toBe('inApp');
    expect(job?.missedRunPolicy).toBe('skip');
    const time = obsidianSecondBrain.requires.inputs.find((i) => i.key === 'consolidationTime');
    expect(time?.default).toBe('30 23 * * *');
  });
});

describe('link-archiver', () => {
  it('needs no channel and delivers its digest in-app', () => {
    expect(linkArchiver.requires.channels).toEqual([]);
    expect(linkArchiver.cronJobs.map((j) => j.deliverTo)).toEqual(['inApp']);
  });
});

describe('web-watchdog', () => {
  it('delivers to a channel and declares the required chatTarget that needs', () => {
    expect(webWatchdog.cronJobs.map((j) => j.deliverTo)).toEqual(['channel']);
    const chatTarget = webWatchdog.requires.inputs.find((i) => i.kind === 'chatTarget');
    expect(chatTarget?.required).toBe(true);
  });
});
