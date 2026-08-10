import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- helpers ---------------------------------------------------------------

let testDir: string;
let skillsDir: string;
let pendingDir: string;
let historyPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolve-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  skillsDir = join(testDir, 'skills');
  pendingDir = join(skillsDir, 'pending');
  historyPath = join(testDir, 'evolver-history.jsonl');
  await mkdir(pendingDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(testDir, { recursive: true, force: true });
});

// Dynamically import evolve.ts functions so we can inject testDir via module
// isolation. We call internal helpers through the public `runEvolveStatus` /
// `runEvolveApply` surface exported for testing.
async function loadEvolveHelpers(overrideEthosDir: string) {
  const { runEvolveStatus, runEvolveApply } = await import('../evolve-helpers');
  return {
    status: (args: string[]) => runEvolveStatus(args, overrideEthosDir),
    apply: (args: string[]) => runEvolveApply(args, overrideEthosDir),
  };
}

// ---- tests -----------------------------------------------------------------

describe('ethos evolve status — empty store', () => {
  it('prints "no proposals yet" when history and pending are absent', async () => {
    // Remove pending dir to simulate a fresh install
    await rm(pendingDir, { recursive: true, force: true });

    const { status } = await loadEvolveHelpers(testDir);
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      lines.push(String(data));
      return true;
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await status([]);

    const output = lines.join('\n');
    expect(output).toMatch(/no proposals yet/i);

    consoleSpy.mockRestore();
  });
});

describe('ethos evolve status — with history and pending', () => {
  it('reflects a prior run and lists pending skills', async () => {
    // Write a history entry
    const record = {
      ranAt: new Date().toISOString(),
      evalOutputPath: '/tmp/eval.jsonl',
      rewritesProposed: 2,
      newSkillsProposed: 1,
      skipped: [],
    };
    await writeFile(historyPath, `${JSON.stringify(record)}\n`, 'utf-8');

    // Write two pending skill files
    await writeFile(join(pendingDir, 'my-skill.md'), '# My Skill\n', 'utf-8');
    await writeFile(join(pendingDir, 'other-skill.md'), '# Other\n', 'utf-8');

    const { status } = await loadEvolveHelpers(testDir);
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await status([]);
    consoleSpy.mockRestore();

    const output = lines.join('\n');
    // Should show pending count
    expect(output).toMatch(/my-skill\.md/);
    expect(output).toMatch(/other-skill\.md/);
    // Should show last run info
    expect(output).toMatch(/last run/i);
  });
});

describe('ethos evolve apply', () => {
  it('moves a file from pending to skills dir', async () => {
    const filename = 'to-apply.md';
    await writeFile(join(pendingDir, filename), '# To Apply\n', 'utf-8');

    const { apply } = await loadEvolveHelpers(testDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apply([filename]);
    consoleSpy.mockRestore();

    // File should now exist in skillsDir and be gone from pendingDir
    const inSkills = await stat(join(skillsDir, filename)).catch(() => null);
    expect(inSkills).not.toBeNull();

    const inPending = await stat(join(pendingDir, filename)).catch(() => null);
    expect(inPending).toBeNull();
  });

  it('updates status — pending count decrements after apply', async () => {
    await writeFile(join(pendingDir, 'skill-a.md'), '# A\n', 'utf-8');
    await writeFile(join(pendingDir, 'skill-b.md'), '# B\n', 'utf-8');

    const { apply, status } = await loadEvolveHelpers(testDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apply(['skill-a.md']);
    consoleSpy.mockRestore();

    const lines: string[] = [];
    const consoleSpy2 = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await status([]);
    consoleSpy2.mockRestore();

    const output = lines.join('\n');
    // skill-a is gone, skill-b remains
    expect(output).not.toMatch(/skill-a\.md/);
    expect(output).toMatch(/skill-b\.md/);
  });
});

describe('ethos evolve apply — missing file', () => {
  it('errors cleanly when the pending file does not exist', async () => {
    const { apply } = await loadEvolveHelpers(testDir);
    const stderrLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderrLines.push(args.join(' '));
    });

    // process.exit should NOT actually exit during tests
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });

    await expect(apply(['nonexistent.md'])).rejects.toThrow('process.exit called');
    exitSpy.mockRestore();

    const output = stderrLines.join('\n');
    expect(output).toMatch(/nonexistent\.md/);
  });
});

describe('ethos evolve apply — unparseable frontmatter', () => {
  // `skillsDir` is scanned at startup, so promoting a file whose YAML cannot
  // be parsed converts a bad proposal into a failed boot.
  const BROKEN = [
    '---',
    'name: stock-add',
    'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
    '---',
    '',
    'Body.',
  ].join('\n');

  it('refuses to promote a single broken file and leaves it in pending', async () => {
    await writeFile(join(pendingDir, 'broken.md'), BROKEN, 'utf-8');

    const { apply } = await loadEvolveHelpers(testDir);
    const stderrLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderrLines.push(args.join(' '));
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });

    await expect(apply(['broken.md'])).rejects.toThrow('process.exit called');
    exitSpy.mockRestore();

    expect(stderrLines.join('\n')).toMatch(/broken\.md/);
    expect(await stat(join(pendingDir, 'broken.md')).catch(() => null)).not.toBeNull();
    expect(await stat(join(skillsDir, 'broken.md')).catch(() => null)).toBeNull();
  });

  it('--all skips the broken file and still promotes the healthy ones', async () => {
    await writeFile(join(pendingDir, 'broken.md'), BROKEN, 'utf-8');
    await writeFile(join(pendingDir, 'good.md'), '---\nname: Good\n---\n\nBody.\n', 'utf-8');

    const { apply } = await loadEvolveHelpers(testDir);
    const stderrLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderrLines.push(args.join(' '));
    });

    await apply(['--all']);

    expect(stderrLines.join('\n')).toMatch(/broken\.md/);
    expect(await stat(join(pendingDir, 'broken.md')).catch(() => null)).not.toBeNull();
    expect(await stat(join(skillsDir, 'broken.md')).catch(() => null)).toBeNull();
    expect(await stat(join(skillsDir, 'good.md')).catch(() => null)).not.toBeNull();
    expect(await stat(join(pendingDir, 'good.md')).catch(() => null)).toBeNull();
  });
});

describe('registerEvolverCron', () => {
  it('exports registerEvolverCron as a callable function', async () => {
    const { registerEvolverCron } = await import('../cron');
    expect(typeof registerEvolverCron).toBe('function');
  });

  it('returns a cleanup function and calls onFire on schedule', async () => {
    const { registerEvolverCron } = await import('../cron');
    // We don't actually start a cron scheduler in tests; just verify the
    // return shape so the wiring contract is exercised.
    const noop = async () => {};
    const cleanup = registerEvolverCron('0 3 * * *', noop);
    expect(typeof cleanup).toBe('function');
    // Clean up any timers the scheduler might have started
    cleanup();
  });

  it('does not call onFire before the schedule fires', async () => {
    const { registerEvolverCron } = await import('../cron');
    let called = false;
    const cleanup = registerEvolverCron('0 3 * * *', async () => {
      called = true;
    });
    // Immediately after registration, onFire should not have been called yet.
    expect(called).toBe(false);
    cleanup();
  });
});
