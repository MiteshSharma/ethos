// Skill install atomicity.
//
// `ethos skills install` must never leave a half-written skill on disk. The
// install runs into a per-pid tmp dir; only after the installer returns
// successfully do we rename the slug subtree into its final location. The
// regression test simulates "SIGKILL during install" by having the fake
// installer throw partway: the destination must remain untouched and no
// half-written `<skillsRoot>/<slug>/` is left behind.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicInstall } from '../commands/skills';

async function makeRoot(label: string): Promise<string> {
  const root = join(
    tmpdir(),
    `ethos-skills-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  return root;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('atomicInstall', () => {
  it('moves the slug subtree into place after the installer succeeds', async () => {
    const root = await makeRoot('ok');
    await atomicInstall({
      slug: 'owner/skill',
      skillsRoot: root,
      runInstaller: async (workdir) => {
        // Simulate clawhub creating a scoped subtree.
        await mkdir(join(workdir, 'owner', 'skill'), { recursive: true });
        await writeFile(join(workdir, 'owner', 'skill', 'SKILL.md'), '# Skill content\n', 'utf-8');
      },
    });

    expect(await pathExists(join(root, 'owner', 'skill', 'SKILL.md'))).toBe(true);
    expect(await readFile(join(root, 'owner', 'skill', 'SKILL.md'), 'utf-8')).toContain(
      'Skill content',
    );
  });

  it('handles flat (unscoped) slugs by moving the leaf SKILL.md dir into place', async () => {
    const root = await makeRoot('flat');
    await atomicInstall({
      slug: 'flat-skill',
      skillsRoot: root,
      runInstaller: async (workdir) => {
        await mkdir(join(workdir, 'flat-skill'), { recursive: true });
        await writeFile(join(workdir, 'flat-skill', 'SKILL.md'), '# Flat\n', 'utf-8');
      },
    });

    expect(await pathExists(join(root, 'flat-skill', 'SKILL.md'))).toBe(true);
  });

  it('cleans up tmp and leaves no partial slug dir when the installer throws midway', async () => {
    const root = await makeRoot('crash');
    await expect(
      atomicInstall({
        slug: 'owner/crashing',
        skillsRoot: root,
        runInstaller: async (workdir) => {
          // Simulate a half-finished download: create a few files, then throw
          // before SKILL.md exists — the equivalent of SIGKILL mid-install.
          await mkdir(join(workdir, 'owner', 'crashing'), { recursive: true });
          await writeFile(
            join(workdir, 'owner', 'crashing', 'partial-asset.bin'),
            'incomplete bytes',
            'utf-8',
          );
          throw new Error('simulated SIGKILL');
        },
      }),
    ).rejects.toThrow(/simulated SIGKILL/);

    // Destination must NEVER exist.
    expect(await pathExists(join(root, 'owner'))).toBe(false);
    expect(await pathExists(join(root, 'owner', 'crashing'))).toBe(false);

    // Tmp dir for our pid must be cleaned up (other in-flight installs may
    // remain, but ours is gone).
    const tmpRoot = join(root, '.tmp');
    if (await pathExists(tmpRoot)) {
      const entries = await readdir(tmpRoot);
      const ours = entries.filter((e) => e.endsWith(`-${process.pid}`));
      expect(ours).toEqual([]);
    }

    // Lock must be released so subsequent installs can proceed.
    expect(await pathExists(join(root, '.lock'))).toBe(false);
  });

  it('fails with a clear error when the installer produces no SKILL.md', async () => {
    const root = await makeRoot('no-skill-md');
    await expect(
      atomicInstall({
        slug: 'owner/empty',
        skillsRoot: root,
        runInstaller: async (workdir) => {
          await mkdir(join(workdir, 'owner', 'empty'), { recursive: true });
          // No SKILL.md written.
        },
      }),
    ).rejects.toThrow(/SKILL\.md/);

    expect(await pathExists(join(root, 'owner'))).toBe(false);
    expect(await pathExists(join(root, '.lock'))).toBe(false);
  });

  it('replaces an existing skill atomically on update (rename-aside, swap-in, drop-aside)', async () => {
    const root = await makeRoot('update');
    // Pre-seed an existing install.
    await mkdir(join(root, 'owner', 'skill'), { recursive: true });
    await writeFile(join(root, 'owner', 'skill', 'SKILL.md'), '# v1\n', 'utf-8');

    await atomicInstall({
      slug: 'owner/skill',
      skillsRoot: root,
      runInstaller: async (workdir) => {
        await mkdir(join(workdir, 'owner', 'skill'), { recursive: true });
        await writeFile(join(workdir, 'owner', 'skill', 'SKILL.md'), '# v2\n', 'utf-8');
      },
    });

    expect(await readFile(join(root, 'owner', 'skill', 'SKILL.md'), 'utf-8')).toContain('# v2');

    // Aside must be cleaned up after a successful swap.
    const ownerEntries = await readdir(join(root, 'owner'));
    const asideMatches = ownerEntries.filter((n) => n.startsWith('skill.old-'));
    expect(asideMatches).toEqual([]);
  });

  it('serializes concurrent installs through the lock file (second install runs after the first)', async () => {
    const root = await makeRoot('concurrent');
    let firstReleased = false;
    let firstHasLock!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      firstHasLock = resolve;
    });

    const first = atomicInstall({
      slug: 'a/one',
      skillsRoot: root,
      pid: 1001,
      runInstaller: async (workdir) => {
        // Signal we've taken the lock, then hold it briefly so the second
        // caller is guaranteed to enter the EEXIST poll loop.
        firstHasLock();
        await new Promise((r) => setTimeout(r, 100));
        await mkdir(join(workdir, 'a', 'one'), { recursive: true });
        await writeFile(join(workdir, 'a', 'one', 'SKILL.md'), '# 1\n', 'utf-8');
        firstReleased = true;
      },
    });

    // Start the second install only after we know the first holds the lock.
    await firstAcquired;
    const second = atomicInstall({
      slug: 'a/two',
      skillsRoot: root,
      pid: 1002,
      runInstaller: async (workdir) => {
        // The first install must have fully completed (lock is exclusive).
        expect(firstReleased).toBe(true);
        await mkdir(join(workdir, 'a', 'two'), { recursive: true });
        await writeFile(join(workdir, 'a', 'two', 'SKILL.md'), '# 2\n', 'utf-8');
      },
    });

    await Promise.all([first, second]);
    expect(await pathExists(join(root, 'a', 'one', 'SKILL.md'))).toBe(true);
    expect(await pathExists(join(root, 'a', 'two', 'SKILL.md'))).toBe(true);
  });
});
