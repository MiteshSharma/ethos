import { spawnSync } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
      installSkill(slug);
      break;
    }

    case 'update': {
      const slug = args[1];
      if (slug) {
        updateOne(slug);
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

function installSkill(slug: string): void {
  const dir = skillsRoot();
  console.log(
    `${c.dim}Installing ${c.reset}${c.bold}${slug}${c.reset}${c.dim} via clawhub to ${dir}...${c.reset}\n`,
  );
  const result = runClawhub(['install', '--workdir', dir, slug]);
  if (result.status !== 0) {
    console.error(`${c.red}Install failed.${c.reset}`);
    process.exit(result.status ?? 1);
  }
  console.log(`\n${c.green}✓ Installed ${slug}.${c.reset}`);
}

function updateOne(slug: string): void {
  const dir = skillsRoot();
  console.log(`${c.dim}Updating ${c.reset}${c.bold}${slug}${c.reset}${c.dim}...${c.reset}\n`);
  // clawhub treats `install` of an existing slug as an update.
  const result = runClawhub(['install', '--workdir', dir, slug]);
  if (result.status !== 0) {
    console.error(`${c.red}Update failed.${c.reset}`);
    process.exit(result.status ?? 1);
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
    updateOne(slug);
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
