// Non-interactive skill install: --yes flag and TTY detection.
//
// When stdin is not a TTY (Clawrium's SSH-driven playbooks, CI, managed mode),
// `promptConfirm` would hang forever. The `resolveYellowFindings` function
// short-circuits: --yes proceeds, otherwise fail-fast with an actionable error.
// Red findings always hard-throw in `scanSkillDir` before reaching this path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import type { ScanFinding } from '@ethosagent/wiring/security-kernel';
import { describe, expect, it } from 'vitest';
import { resolveYellowFindings } from '../commands/skills';

const yellowFinding: ScanFinding = {
  severity: 'yellow',
  rule: 'hidden-unicode',
  message: 'Contains invisible characters',
};

describe('resolveYellowFindings', () => {
  it('throws EthosError when yellow finding + no TTY + no --yes (does not hang)', {
    timeout: 2000,
  }, () => {
    expect(() =>
      resolveYellowFindings({
        slug: 'owner/skill',
        findings: [yellowFinding],
        yesFlag: false,
        isTTY: false,
        managed: false,
      }),
    ).toThrow(EthosError);

    try {
      resolveYellowFindings({
        slug: 'owner/skill',
        findings: [yellowFinding],
        yesFlag: false,
        isTTY: false,
        managed: false,
      });
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('SKILL_INSTALL_FAILED');
      expect(e.action).toContain('--yes');
    }
  });

  it('proceeds when yellow finding + no TTY + --yes', () => {
    const result = resolveYellowFindings({
      slug: 'owner/skill',
      findings: [yellowFinding],
      yesFlag: true,
      isTTY: false,
      managed: false,
    });
    expect(result).toBe('proceed');
  });

  it('throws EthosError when yellow finding + ETHOS_MANAGED=1 + no --yes', () => {
    expect(() =>
      resolveYellowFindings({
        slug: 'owner/skill',
        findings: [yellowFinding],
        yesFlag: false,
        isTTY: true,
        managed: true,
      }),
    ).toThrow(EthosError);

    try {
      resolveYellowFindings({
        slug: 'owner/skill',
        findings: [yellowFinding],
        yesFlag: false,
        isTTY: true,
        managed: true,
      });
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('SKILL_INSTALL_FAILED');
      expect(e.action).toContain('--yes');
    }
  });

  it('red findings still hard-throw in scanSkillDir before reaching yellow path', () => {
    // `resolveYellowFindings` is only called after the red-finding guard in
    // scanSkillDir. Verify the source structure: the red check (`result.hasRed`)
    // must appear before the `resolveYellowFindings` call.
    const src = readFileSync(
      join(import.meta.dirname, '..', 'commands', 'skills.ts'),
      'utf8',
    ) as string;

    const redCheckIndex = src.indexOf('if (result.hasRed)');
    const resolveCallIndex = src.indexOf('resolveYellowFindings(');
    expect(redCheckIndex).toBeGreaterThan(-1);
    expect(resolveCallIndex).toBeGreaterThan(-1);
    // Red guard must come before the yellow resolver in source order.
    expect(redCheckIndex).toBeLessThan(resolveCallIndex);

    // And the red path throws EthosError with SKILL_INSTALL_FAILED.
    const redBlock = src.slice(redCheckIndex, redCheckIndex + 400);
    expect(redBlock).toContain("code: 'SKILL_INSTALL_FAILED'");
    expect(redBlock).toContain('throw new EthosError');
  });

  it('proceeds when yellow finding + ETHOS_MANAGED=1 + --yes', () => {
    const result = resolveYellowFindings({
      slug: 'owner/skill',
      findings: [yellowFinding],
      yesFlag: true,
      isTTY: true,
      managed: true,
    });
    expect(result).toBe('proceed');
  });

  it('returns prompt when yellow finding + TTY + no --yes + not managed', () => {
    const result = resolveYellowFindings({
      slug: 'owner/skill',
      findings: [yellowFinding],
      yesFlag: false,
      isTTY: true,
      managed: false,
    });
    expect(result).toBe('prompt');
  });

  it('error message includes all yellow finding rule names', () => {
    const findings: ScanFinding[] = [
      { severity: 'yellow', rule: 'hidden-unicode', message: 'test' },
      { severity: 'yellow', rule: 'suspicious-import', message: 'test' },
    ];
    try {
      resolveYellowFindings({
        slug: 'owner/skill',
        findings,
        yesFlag: false,
        isTTY: false,
        managed: false,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as EthosError;
      expect(e.cause).toContain('hidden-unicode');
      expect(e.cause).toContain('suspicious-import');
    }
  });
});
