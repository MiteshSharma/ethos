// G5 — install-time consent for plugins.
//
// Installing a plugin is equivalent to running arbitrary code as your user, and
// nothing in the framework changes that. What these tests pin is that the
// operator is told so at the moment they take it on, that the install cannot
// proceed without a recorded grant, and that a non-interactive install records
// consent explicitly rather than skipping it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { PLUGIN_CONSEQUENCE, resolvePluginConsent } from '../commands/plugin';
import { SKILL_CONSEQUENCE } from '../commands/skills';

function pluginSource(): string {
  return readFileSync(join(import.meta.dirname, '..', 'commands', 'plugin.ts'), 'utf8');
}

describe('the operator consequence sentence', () => {
  it('says installing a plugin runs arbitrary code as the user, unsoftened', () => {
    expect(PLUGIN_CONSEQUENCE).toBe(
      'Installing a plugin is equivalent to running arbitrary code as your user.',
    );
  });

  it('appears in the skill install prompt too', () => {
    expect(SKILL_CONSEQUENCE).toBe(
      'Installing a skill is equivalent to running arbitrary code as your user.',
    );
  });

  it('is printed at the plugin install decision point', () => {
    const src = pluginSource();
    expect(src).toContain('printPluginConsequence(draft)');
  });

  it('calls the scanner advisory, not a boundary', () => {
    const src = pluginSource();
    // The consequence block must state the scan sandboxes nothing.
    expect(src).toContain('sandboxes nothing');
    expect(src).toContain('what the plugin declares, not limits it is held to');
  });

  it('is printed before the skill installer runs', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'commands', 'skills.ts'), 'utf8');
    const consequenceIdx = src.indexOf('printSkillConsequence();');
    const clawhubIdx = src.indexOf('runClawhub([');
    expect(consequenceIdx).toBeGreaterThan(-1);
    expect(clawhubIdx).toBeGreaterThan(-1);
    expect(consequenceIdx).toBeLessThan(clawhubIdx);
  });
});

describe('resolvePluginConsent', () => {
  it('refuses the install when consent cannot be taken (no TTY, no --yes)', () => {
    expect(() =>
      resolvePluginConsent({
        pkg: 'ethos-plugin-demo',
        yesFlag: false,
        isTTY: false,
        managed: false,
      }),
    ).toThrow(EthosError);

    try {
      resolvePluginConsent({
        pkg: 'ethos-plugin-demo',
        yesFlag: false,
        isTTY: false,
        managed: false,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('PLUGIN_INSTALL_FAILED');
      expect(e.cause).toContain('capability grant');
      expect(e.action).toContain('--yes');
    }
  });

  it('refuses in managed mode without --yes', () => {
    expect(() =>
      resolvePluginConsent({
        pkg: 'ethos-plugin-demo',
        yesFlag: false,
        isTTY: true,
        managed: true,
      }),
    ).toThrow(EthosError);
  });

  it('proceeds unattended with --yes — recording consent, not bypassing it', () => {
    expect(
      resolvePluginConsent({
        pkg: 'ethos-plugin-demo',
        yesFlag: true,
        isTTY: false,
        managed: true,
      }),
    ).toBe('proceed');
  });

  it('prompts on an interactive terminal', () => {
    expect(
      resolvePluginConsent({
        pkg: 'ethos-plugin-demo',
        yesFlag: false,
        isTTY: true,
        managed: false,
      }),
    ).toBe('prompt');
  });
});

describe('install ordering', () => {
  it('records the grant before the package is installed', () => {
    // No grant, no code on disk: the write happens before the final
    // `npm install --prefix <plugins dir>`, so a failed grant write aborts
    // the install rather than leaving unconsented code behind.
    const src = pluginSource();
    const recordIdx = src.indexOf('await recordGrant(getStorage()');
    const finalInstallIdx = src.indexOf("['install', '--prefix', dir,");
    expect(recordIdx).toBeGreaterThan(-1);
    expect(finalInstallIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(finalInstallIdx);
  });

  it('takes consent after the scan decision, and before recording', () => {
    const src = pluginSource();
    const consentIdx = src.indexOf('const mode = resolvePluginConsent(');
    const recordIdx = src.indexOf('await recordGrant(getStorage()');
    expect(consentIdx).toBeGreaterThan(-1);
    expect(consentIdx).toBeLessThan(recordIdx);
  });

  it('exits without recording a grant when the operator declines', () => {
    const src = pluginSource();
    const declineIdx = src.indexOf(
      'Install cancelled. Nothing was installed and no grant recorded.',
    );
    const recordIdx = src.indexOf('await recordGrant(getStorage()');
    expect(declineIdx).toBeGreaterThan(-1);
    expect(declineIdx).toBeLessThan(recordIdx);
  });
});
