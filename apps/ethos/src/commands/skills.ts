import { spawnSync } from 'node:child_process';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { ethosDir } from '../config';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function skillsRoot(): string {
  return join(ethosDir(), 'skills');
}

export async function runSkills(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'install': {
      const slug = args[1];
      if (!slug) {
        console.log('Usage: ethos skills install <slug>');
        console.log('  e.g. ethos skills install steipete/slack');
        console.log('       ethos skills install github:owner/repo/path');
        process.exit(1);
      }
      await installSkill(slug);
      break;
    }

    case 'update': {
      const slug = args[1];
      if (slug) {
        await updateOne(slug);
      } else {
        await updateAll();
      }
      break;
    }

    case 'remove': {
      const slug = args[1];
      if (!slug) {
        console.log('Usage: ethos skills remove <slug>');
        process.exit(1);
      }
      await removeSkill(slug);
      break;
    }

    case 'list': {
      await listSkills();
      break;
    }

    default:
      console.log('Usage: ethos skills [install <slug> | list | update [slug] | remove <slug>]');
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function installSkill(slug: string): Promise<void> {
  const dir = skillsRoot();
  console.log(
    `${c.dim}Installing ${c.reset}${c.bold}${slug}${c.reset}${c.dim} via clawhub to ${dir}...${c.reset}\n`,
  );
  try {
    await atomicInstall({
      slug,
      skillsRoot: dir,
      runInstaller: async (workdir) => {
        const result = runClawhub(['install', '--workdir', workdir, slug]);
        if (result.status !== 0) {
          throw new EthosError({
            code: 'SKILL_INSTALL_FAILED',
            cause: `clawhub exited with status ${result.status ?? 'unknown'}`,
            action: 'Check the clawhub output above and re-run with the corrected slug.',
          });
        }
      },
    });
  } catch (err) {
    if (err instanceof EthosError) {
      console.error(`${c.red}${err.cause}${c.reset}\n${c.dim}→ ${err.action}${c.reset}`);
    } else {
      console.error(
        `${c.red}Install failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
    process.exit(1);
  }
  console.log(`\n${c.green}✓ Installed ${slug}.${c.reset}`);
}

async function updateOne(slug: string): Promise<void> {
  const dir = skillsRoot();
  console.log(`${c.dim}Updating ${c.reset}${c.bold}${slug}${c.reset}${c.dim}...${c.reset}\n`);
  try {
    // clawhub treats `install` of an existing slug as an update.
    await atomicInstall({
      slug,
      skillsRoot: dir,
      runInstaller: async (workdir) => {
        const result = runClawhub(['install', '--workdir', workdir, slug]);
        if (result.status !== 0) {
          throw new EthosError({
            code: 'SKILL_INSTALL_FAILED',
            cause: `clawhub exited with status ${result.status ?? 'unknown'}`,
            action: 'Check the clawhub output above and re-run with the corrected slug.',
          });
        }
      },
    });
  } catch (err) {
    if (err instanceof EthosError) {
      console.error(`${c.red}${err.cause}${c.reset}\n${c.dim}→ ${err.action}${c.reset}`);
    } else {
      console.error(
        `${c.red}Update failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
    process.exit(1);
  }
  console.log(`\n${c.green}✓ Updated ${slug}.${c.reset}`);
}

async function updateAll(): Promise<void> {
  const slugs = await listInstalledSlugs();
  if (slugs.length === 0) {
    console.log(`${c.dim}No skills installed.${c.reset}`);
    return;
  }
  for (const slug of slugs) {
    await updateOne(slug);
  }
}

async function removeSkill(slug: string): Promise<void> {
  const target = join(skillsRoot(), slug);
  try {
    const s = await stat(target);
    if (!s.isDirectory()) {
      console.error(`${c.red}Not a skill directory: ${target}${c.reset}`);
      process.exit(1);
    }
  } catch {
    console.error(`${c.red}Skill not found: ${slug}${c.reset}`);
    process.exit(1);
  }
  await rm(target, { recursive: true, force: true });
  console.log(`${c.green}✓ Removed ${slug}.${c.reset}`);
}

async function listSkills(): Promise<void> {
  const root = skillsRoot();
  const slugs = await listInstalledSlugs();

  if (slugs.length === 0) {
    console.log(`\n${c.dim}No skills installed.${c.reset}`);
    console.log(`${c.dim}Install one with: ${c.reset}ethos skills install <slug>\n`);
    return;
  }

  console.log(`\n${c.bold}Installed skills${c.reset}  ${c.dim}(${root})${c.reset}`);
  for (const slug of slugs) {
    console.log(`  ${c.cyan}${slug}${c.reset}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Atomic install
// ---------------------------------------------------------------------------
//
// Skill installs must never leave a half-written `<skillsRoot>/<slug>/` on
// disk: the user runs `ethos skills install`, kills the process during a slow
// download, and the directory is either present-and-complete or absent.
//
// Strategy:
//   1. Acquire an exclusive lock on `<skillsRoot>/.lock` (concurrent installs
//      serialize behind it; a second caller waits up to LOCK_TIMEOUT_MS).
//   2. Run the installer (clawhub) into a per-pid temp dir under
//      `<skillsRoot>/.tmp/<slug>-<pid>/`.
//   3. After the installer reports success, locate the slug subtree (the
//      directory containing `SKILL.md`) and atomically `rename(2)` it into
//      its final destination. If the destination already exists (update
//      flow), rename it aside first, swap the new in, then remove the aside.
//   4. On any error, `rm -rf` the temp dir; the destination stays untouched.
//   5. SIGKILL during step 2 leaves orphaned tmp dirs but never a partial
//      `<skillsRoot>/<slug>/` — `listInstalledSlugs()` skips dotfile
//      directories so the orphaned `.tmp/` is invisible to users. Subsequent
//      installs can reuse the tmp namespace freely (per-pid suffix avoids
//      collisions).

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 200;

interface AtomicInstallOpts {
  slug: string;
  skillsRoot: string;
  /**
   * Runs the actual install into the supplied workdir. Must throw on failure.
   * On return, the workdir is expected to contain the slug subtree (one
   * `SKILL.md` file marks the leaf directory).
   */
  runInstaller: (workdir: string) => Promise<void>;
  /** Override pid for deterministic tests; defaults to `process.pid`. */
  pid?: number;
}

export async function atomicInstall(opts: AtomicInstallOpts): Promise<void> {
  const { slug, skillsRoot, runInstaller } = opts;
  const pid = opts.pid ?? process.pid;
  const tmpRoot = join(skillsRoot, '.tmp');
  const lockPath = join(skillsRoot, '.lock');

  await mkdir(skillsRoot, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const tmpDir = join(tmpRoot, `${slug.replace(/[^A-Za-z0-9._-]/g, '_')}-${pid}`);

  const releaseLock = await acquireLock(lockPath);
  try {
    // Wipe any prior remnant for this pid, then create a fresh tmp dir.
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    // If the installer throws, the `finally` below still runs `rm -rf` on the
    // tmp dir — destination is never touched.
    await runInstaller(tmpDir);

    // Locate the slug subtree by finding the SKILL.md leaf.
    const slugSubpath = await locateSlugSubpath(tmpDir);
    if (!slugSubpath) {
      throw new EthosError({
        code: 'SKILL_INSTALL_FAILED',
        cause: `installer produced no SKILL.md under ${tmpDir}`,
        action:
          'The slug may be wrong, or the upstream skill is missing SKILL.md. Check the installer output above.',
      });
    }

    const src = join(tmpDir, slugSubpath);
    const dst = join(skillsRoot, slugSubpath);

    await mkdir(dirname(dst), { recursive: true });

    // If the destination exists (update flow), rename it aside first so the
    // swap-in is still atomic. We restore the aside if rename fails.
    let aside: string | undefined;
    try {
      await stat(dst);
      aside = `${dst}.old-${pid}`;
      await rm(aside, { recursive: true, force: true });
      await rename(dst, aside);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== 'ENOENT') throw err;
      // Destination doesn't exist — first-time install.
    }

    try {
      await rename(src, dst);
    } catch (err) {
      // Roll back: restore the aside.
      if (aside) {
        try {
          await rename(aside, dst);
        } catch {
          // Best-effort; leave the aside in place if even rollback fails.
        }
      }
      throw err;
    }

    // Success → drop the aside copy.
    if (aside) await rm(aside, { recursive: true, force: true });
  } finally {
    // Always clean up the per-pid tmp directory; never leaves a half-written
    // dir under <skillsRoot>/<slug>/ either way.
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    await releaseLock();
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Lock file already gone — nothing to release.
        }
      };
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== 'EEXIST') throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new EthosError({
          code: 'SKILL_INSTALL_FAILED',
          cause: `another skill install is in progress (lock held: ${lockPath})`,
          action:
            'Wait for the other install to finish. If no install is running, remove the lock file manually.',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function locateSlugSubpath(tmpDir: string): Promise<string | undefined> {
  // Walk `tmpDir` looking for the first `SKILL.md`; return its parent dir
  // path relative to `tmpDir`. clawhub may emit either `<slug>/SKILL.md` or
  // `<scope>/<name>/SKILL.md`, so we don't pre-assume the depth.
  const stack: string[] = [tmpDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Array<{ name: string; isDir: boolean; isFile: boolean }>;
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile && entry.name === 'SKILL.md') {
        const parent = dirname(full);
        return relative(tmpDir, parent);
      }
      if (entry.isDir) stack.push(full);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runClawhub(extraArgs: string[]) {
  // Prefer a globally-installed `clawhub`, otherwise fall back to `npx clawhub@latest`.
  const direct = spawnSync('clawhub', ['--version'], { stdio: 'ignore' });
  if (direct.status === 0) {
    return spawnSync('clawhub', extraArgs, { stdio: 'inherit' });
  }
  return spawnSync('npx', ['clawhub@latest', ...extraArgs], { stdio: 'inherit' });
}

async function listInstalledSlugs(): Promise<string[]> {
  const root = skillsRoot();
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(root, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }

  const slugs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDir) continue;
    if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
    const skillRoot = join(root, entry.name);

    if (await exists(join(skillRoot, 'SKILL.md'))) {
      slugs.push(entry.name);
      continue;
    }

    // Scoped: <root>/<scope>/<slug>/SKILL.md
    try {
      const inner = await readdir(skillRoot, { withFileTypes: true });
      for (const child of inner.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory()) continue;
        if (await exists(join(skillRoot, child.name, 'SKILL.md'))) {
          slugs.push(`${entry.name}/${child.name}`);
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  return slugs;
}

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
